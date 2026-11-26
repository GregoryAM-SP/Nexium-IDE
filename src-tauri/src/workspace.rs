use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Folders that would swamp the explorer (and the AI context) if listed.
const IGNORED_DIRS: [&str; 10] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".svelte-kit",
    ".turbo",
    ".venv",
    "__pycache__",
];

const MAX_ENTRIES: usize = 5000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Images are handed to the webview as a data URL, so keep them reasonable.
const MAX_MEDIA_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct EntryNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<EntryNode>>,
}

#[derive(Serialize)]
pub struct WorkspaceSnapshot {
    pub root: String,
    pub name: String,
    pub children: Vec<EntryNode>,
}

/// Joins a relative path onto the open folder, refusing anything that could
/// escape it (`..`, absolute paths, drive prefixes).
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    let trimmed = relative.trim().trim_matches(['/', '\\']);

    if trimmed.is_empty() {
        return Ok(path);
    }

    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(name) => path.push(name),
            Component::CurDir => {}
            _ => return Err("That path is outside the open folder.".into()),
        }
    }

    Ok(path)
}

fn to_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rest| rest.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn build_children(dir: &Path, root: &Path, counter: &mut usize) -> Vec<EntryNode> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut folders: Vec<EntryNode> = Vec::new();
    let mut files: Vec<EntryNode> = Vec::new();

    for entry in entries.flatten() {
        if *counter >= MAX_ENTRIES {
            break;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        // Symlinks are skipped so a link back up the tree cannot loop forever.
        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }

            *counter += 1;
            let children = build_children(&path, root, counter);
            folders.push(EntryNode {
                name,
                path: to_relative(root, &path),
                kind: "folder",
                children: Some(children),
            });
        } else if metadata.is_file() {
            if name == ".DS_Store" {
                continue;
            }

            *counter += 1;
            files.push(EntryNode {
                name,
                path: to_relative(root, &path),
                kind: "file",
                children: None,
            });
        }
    }

    folders.sort_by_key(|node| node.name.to_lowercase());
    files.sort_by_key(|node| node.name.to_lowercase());
    folders.extend(files);
    folders
}

pub fn open(root: &Path) -> Result<WorkspaceSnapshot, String> {
    // `fs::canonicalize` returns a `\\?\` verbatim path on Windows, which the
    // terminal's PowerShell cannot map to a drive (its prompt showed
    // `Microsoft.PowerShell.Core\FileSystem::\\?\...`). `dunce` returns the
    // plain `C:\...` form whenever one exists.
    let canonical =
        dunce::canonicalize(root).map_err(|_| "That folder could not be opened.".to_string())?;

    if !canonical.is_dir() {
        return Err("That path is not a folder.".into());
    }

    let mut counter = 0;
    let children = build_children(&canonical, &canonical, &mut counter);
    let name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical.to_string_lossy().to_string());

    Ok(WorkspaceSnapshot {
        root: canonical.to_string_lossy().to_string(),
        name,
        children,
    })
}

pub fn read(root: &Path, relative: &str) -> Result<String, String> {
    let path = safe_join(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|_| "That file could not be opened.".to_string())?;

    if !metadata.is_file() {
        return Err("That path is not a file.".into());
    }

    if metadata.len() > MAX_FILE_BYTES {
        return Err("That file is larger than 2 MB, so the editor will not open it.".into());
    }

    fs::read_to_string(&path)
        .map_err(|_| "That file is not UTF-8 text, so the editor cannot open it.".to_string())
}

/// An image's bytes as a data URL payload, for formats the editor shows instead
/// of text. SVG is left out on purpose: it is text, and is both editable and
/// previewable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub mime: String,
    pub base64: String,
}

fn media_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();

    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        // Web fonts are binary too, and the editor shows them as a specimen.
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

pub fn read_media(root: &Path, relative: &str) -> Result<MediaFile, String> {
    let path = safe_join(root, relative)?;
    let mime = media_mime(&path)
        .ok_or_else(|| "That file is not an image or font the editor can display.".to_string())?;
    let metadata = fs::metadata(&path).map_err(|_| "That file could not be opened.".to_string())?;

    if !metadata.is_file() {
        return Err("That path is not a file.".into());
    }

    if metadata.len() > MAX_MEDIA_BYTES {
        return Err("That file is larger than 16 MB, so the editor will not display it.".into());
    }

    let bytes = fs::read(&path).map_err(|_| "That file could not be read.".to_string())?;

    Ok(MediaFile {
        mime: mime.to_string(),
        base64: BASE64.encode(bytes),
    })
}

pub fn write(root: &Path, relative: &str, contents: &str) -> Result<(), String> {
    let path = safe_join(root, relative)?;

    if relative.trim().is_empty() {
        return Err("Choose a file to save into.".into());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::write(&path, contents).map_err(|error| format!("Could not save: {error}"))
}

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();

    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err("Use a single name without slashes.".into());
    }

    Ok(())
}

pub fn create(root: &Path, parent: &str, name: &str, kind: &str) -> Result<String, String> {
    validate_name(name)?;

    let parent_path = safe_join(root, parent)?;
    let path = parent_path.join(name.trim());

    if path.exists() {
        return Err("Something with that name already exists.".into());
    }

    if kind == "folder" {
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    } else {
        fs::create_dir_all(&parent_path).map_err(|error| error.to_string())?;
        fs::write(&path, "").map_err(|error| error.to_string())?;
    }

    Ok(to_relative(root, &path))
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let source = safe_join(root, from)?;
    let target = safe_join(root, to)?;

    if !source.exists() {
        return Err("That file no longer exists.".into());
    }

    if target.exists() {
        return Err("Something with that name already exists.".into());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::rename(&source, &target).map_err(|error| format!("Could not rename: {error}"))
}

fn walk_dir(dir: &Path, root: &Path, lines: &mut Vec<String>, limit: usize) {
    if lines.len() >= limit {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut folders: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            folders.push(path);
        } else if metadata.is_file() {
            files.push(path);
        }
    }

    folders.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    files.sort_by_key(|path| path.to_string_lossy().to_lowercase());

    for folder in &folders {
        if lines.len() >= limit {
            return;
        }

        lines.push(format!("{}/", to_relative(root, folder)));
        walk_dir(folder, root, lines, limit);
    }

    for file in &files {
        if lines.len() >= limit {
            return;
        }

        lines.push(to_relative(root, file));
    }
}

/// Flat listing used by the assistant's `list_files` tool.
pub fn list(root: &Path, relative: &str, limit: usize) -> Result<String, String> {
    let base = safe_join(root, relative)?;

    if !base.exists() {
        return Err(format!("'{relative}' does not exist in this folder."));
    }

    if base.is_file() {
        return Ok(to_relative(root, &base));
    }

    let mut lines = Vec::new();
    walk_dir(&base, root, &mut lines, limit);

    if lines.is_empty() {
        return Ok("(empty folder)".into());
    }

    if lines.len() >= limit {
        lines.push(format!("… truncated at {limit} entries"));
    }

    Ok(lines.join("\n"))
}

fn search_dir(dir: &Path, root: &Path, needle: &str, hits: &mut Vec<String>, limit: usize) {
    if hits.len() >= limit {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        if hits.len() >= limit {
            return;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if !IGNORED_DIRS.contains(&name.as_str()) {
                search_dir(&path, root, needle, hits, limit);
            }
            continue;
        }

        // Skip huge or binary files: the assistant only needs source text.
        if metadata.len() > 512 * 1024 {
            continue;
        }

        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };

        for (index, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(needle) {
                hits.push(format!(
                    "{}:{}: {}",
                    to_relative(root, &path),
                    index + 1,
                    line.trim().chars().take(200).collect::<String>()
                ));

                if hits.len() >= limit {
                    return;
                }
            }
        }
    }
}

/// Case-insensitive text search used by the assistant's `search_text` tool.
pub fn search(
    root: &Path,
    relative: &str,
    needle: &str,
    limit: usize,
) -> Result<String, String> {
    let query = needle.trim().to_lowercase();

    if query.is_empty() {
        return Err("Provide some text to search for.".into());
    }

    let base = safe_join(root, relative)?;

    if !base.exists() {
        return Err(format!("'{relative}' does not exist in this folder."));
    }

    let mut hits = Vec::new();

    if base.is_file() {
        search_dir(base.parent().unwrap_or(root), root, &query, &mut hits, limit);
    } else {
        search_dir(&base, root, &query, &mut hits, limit);
    }

    if hits.is_empty() {
        return Ok(format!("No matches for '{needle}'."));
    }

    Ok(hits.join("\n"))
}

#[derive(Serialize)]
pub struct SourceFile {
    pub path: String,
    pub contents: String,
}

const SOURCE_EXTENSIONS: [&str; 6] = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
const MAX_SOURCE_FILES: usize = 600;
const MAX_SOURCE_BYTES: u64 = 200 * 1024;
const MAX_SOURCE_TOTAL: usize = 6 * 1024 * 1024;

fn collect_sources(
    dir: &Path,
    root: &Path,
    files: &mut Vec<SourceFile>,
    total: &mut usize,
) {
    if files.len() >= MAX_SOURCE_FILES || *total >= MAX_SOURCE_TOTAL {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut folders: Vec<PathBuf> = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if !IGNORED_DIRS.contains(&name.as_str()) {
                folders.push(path);
            }
            continue;
        }

        if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();

        if SOURCE_EXTENSIONS.contains(&extension.as_str()) {
            candidates.push(path);
        }
    }

    folders.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    candidates.sort_by_key(|path| path.to_string_lossy().to_lowercase());

    for file in candidates {
        if files.len() >= MAX_SOURCE_FILES || *total >= MAX_SOURCE_TOTAL {
            return;
        }

        let Ok(contents) = fs::read_to_string(&file) else {
            continue;
        };

        *total += contents.len();
        files.push(SourceFile {
            path: to_relative(root, &file),
            contents,
        });
    }

    for folder in folders {
        collect_sources(&folder, root, files, total);
    }
}

/// Source files loaded into the editor's TypeScript worker so imports between
/// files resolve even when only one of them is open.
pub fn sources(root: &Path) -> Vec<SourceFile> {
    let mut files = Vec::new();
    let mut total = 0;

    collect_sources(root, root, &mut files, &mut total);
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn images_are_read_as_base64_with_their_mime() {
        let root = std::env::temp_dir().join("nexium-media-test-read");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("pixel.png"), [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(root.join("notes.txt"), "hello").unwrap();

        let image = read_media(&root, "pixel.png").unwrap();

        assert_eq!(image.mime, "image/png");
        assert_eq!(image.base64, "iVBORw==");
        assert!(read_media(&root, "notes.txt").is_err());

        // Fonts are binary as well, so they take the same read path.
        fs::write(root.join("face.woff2"), [b'w', b'O', b'F', b'2']).unwrap();
        let font = read_media(&root, "face.woff2").unwrap();

        assert_eq!(font.mime, "font/woff2");
        assert_eq!(font.base64, "d09GMg==");

        fs::remove_dir_all(&root).ok();
    }

    fn temp_root() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nexium-workspace-test-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}\nlet answer = 42;\n").unwrap();
        fs::write(
            root.join("src").join("app.ts"),
            "import { nim } from '../lib/nim';\nexport const value = 1;\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn refuses_paths_that_escape_the_workspace() {
        let root = temp_root();

        assert!(safe_join(&root, "../outside.txt").is_err());
        assert!(safe_join(&root, "src/../../outside.txt").is_err());
        assert!(safe_join(&root, "src/main.rs").unwrap().starts_with(&root));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reads_lists_searches_and_edits_inside_the_root() {
        let root = temp_root();

        assert!(read(&root, "src/main.rs").unwrap().contains("let answer = 42;"));

        let listing = list(&root, "", 100).unwrap();
        assert!(listing.contains("src/"));
        assert!(listing.contains("src/main.rs"));

        let hits = search(&root, "", "LET ANSWER", 20).unwrap();
        assert!(hits.contains("src/main.rs:2:"));

        write(&root, "src/lib.rs", "pub fn add() {}\n").unwrap();
        assert!(read(&root, "src/lib.rs").unwrap().contains("add"));

        create(&root, "src", "extra.rs", "file").unwrap();
        assert!(root.join("src").join("extra.rs").is_file());

        rename(&root, "src/extra.rs", "src/renamed.rs").unwrap();
        assert!(root.join("src").join("renamed.rs").is_file());

        delete(&root, "src/renamed.rs").unwrap();
        assert!(!root.join("src").join("renamed.rs").exists());

        fs::remove_dir_all(&root).ok();
    }

    /// A `\\?\` root made the terminal's PowerShell start at an unmappable
    /// provider path instead of the project folder.
    #[cfg(windows)]
    #[test]
    fn opened_root_has_no_verbatim_prefix() {
        let dir = std::env::temp_dir().join(format!(
            "nexium-verbatim-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let snapshot = open(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert!(!snapshot.root.starts_with(r"\\?\"), "{}", snapshot.root);
    }

    #[test]
    fn collects_only_source_files_for_the_editor() {
        let root = temp_root();
        fs::write(root.join("src").join("styles.css"), "body {}").unwrap();

        let files = sources(&root);
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();

        assert!(paths.contains(&"src/app.ts"));
        assert!(!paths.contains(&"src/main.rs"));
        assert!(!paths.contains(&"src/styles.css"));
        assert!(files
            .iter()
            .find(|file| file.path == "src/app.ts")
            .map(|file| file.contents.contains("../lib/nim"))
            .unwrap_or(false));

        fs::remove_dir_all(&root).ok();
    }
}

pub fn delete(root: &Path, relative: &str) -> Result<(), String> {
    let path = safe_join(root, relative)?;

    if path == root {
        return Err("Open another folder instead of deleting the whole workspace.".into());
    }

    if !path.exists() {
        return Err("That file no longer exists.".into());
    }

    if path.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    }
    .map_err(|error| format!("Could not delete: {error}"))
}
