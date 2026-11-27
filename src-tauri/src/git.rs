use serde::Serialize;
use std::io;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    /// `M`, `A`, `D`, `R`, `C` or `U` for untracked.
    pub status: String,
    pub staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    /// Both values are present, so `git commit` can author a change.
    pub configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    /// The file as committed in HEAD; empty for a new file or a repository
    /// without commits.
    pub original: String,
    /// The side being compared: the staged copy for a staged change, the file
    /// on disk otherwise.
    pub modified: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub changes: Vec<GitChange>,
    pub message: Option<String>,
}

fn execute(root: &Path, args: &[&str], allow_prompt: bool) -> Result<String, String> {
    let mut command = Command::new("git");

    command.arg("-C").arg(root).args(args);

    // The release build is a GUI-subsystem process with no console, so Windows
    // would open (and flash) a fresh console window for every git call.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    if !allow_prompt {
        // A window cannot answer git's credential prompt, so it must fail
        // instead of waiting on a terminal or a credential-manager dialog.
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never");
    }

    let output = command
        .output()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                "Git is not installed or not on PATH.".to_string()
            } else {
                format!("Git could not run: {error}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        return Err(if stderr.is_empty() {
            "Git returned an error.".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run(root: &Path, args: &[&str]) -> Result<String, String> {
    execute(root, args, true)
}

/// Parses `git status --porcelain=v1 -z`, where each entry is `XY path` and a
/// rename or copy is followed by the origin path in its own entry.
fn parse_changes(raw: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    let mut entries = raw.split('\0').filter(|entry| !entry.is_empty());

    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }

        let bytes = entry.as_bytes();
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let path = entry[3..].to_string();

        if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            let _origin = entries.next();
        }

        if index != ' ' && index != '?' {
            changes.push(GitChange {
                path: path.clone(),
                status: index.to_string(),
                staged: true,
            });
        }

        if index == '?' || (worktree != ' ' && worktree != '?') {
            changes.push(GitChange {
                path,
                status: if index == '?' {
                    "U".to_string()
                } else {
                    worktree.to_string()
                },
                staged: false,
            });
        }
    }

    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

pub fn status(root: &Path) -> Result<GitStatus, String> {
    if run(root, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(GitStatus {
            is_repo: false,
            branch: String::new(),
            changes: Vec::new(),
            message: Some("This folder is not a Git repository.".into()),
        });
    }

    let branch = match run(root, &["branch", "--show-current"]) {
        Ok(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => run(root, &["rev-parse", "--short", "HEAD"])
            .map(|sha| format!("HEAD {}", sha.trim()))
            .unwrap_or_else(|_| "no commits yet".to_string()),
    };

    // Without `--untracked-files=all` git collapses a new folder into a single
    // `?? folder/` entry, so its files would never show up in the panel.
    let raw = run(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;

    Ok(GitStatus {
        is_repo: true,
        branch,
        changes: parse_changes(&raw),
        message: None,
    })
}

/// The identity git uses for commits, wherever it is configured.
pub fn identity(root: &Path) -> Result<GitIdentity, String> {
    let name = run(root, &["config", "--get", "user.name"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let email = run(root, &["config", "--get", "user.email"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    Ok(GitIdentity {
        configured: !name.is_empty() && !email.is_empty(),
        name,
        email,
    })
}

/// Writes the identity to the global git config, where commits look for it.
pub fn set_identity(root: &Path, name: &str, email: &str) -> Result<GitIdentity, String> {
    let name = name.trim();
    let email = email.trim();

    if name.is_empty() {
        return Err("Enter the name commits should use.".into());
    }

    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid email address.".into());
    }

    run(root, &["config", "--global", "user.name", name])?;
    run(root, &["config", "--global", "user.email", email])?;

    identity(root)
}

/// The two sides of a change: `HEAD:path` against the index or the file on disk.
pub fn file_diff(root: &Path, path: &str, staged: bool) -> Result<GitFileDiff, String> {
    // A new file has no HEAD entry, and neither has the first commit of a
    // repository, so both read as an empty original.
    let original = run(root, &["show", &format!("HEAD:{path}")]).unwrap_or_default();

    let modified = if staged {
        run(root, &["show", &format!(":{path}")])?
    } else {
        std::fs::read_to_string(root.join(path))
            .map_err(|error| format!("That file could not be read: {error}"))?
    };

    Ok(GitFileDiff { original, modified })
}

pub fn stage(root: &Path, path: &str) -> Result<(), String> {
    run(root, &["add", "--", path]).map(|_| ())
}

pub fn unstage(root: &Path, path: &str) -> Result<(), String> {
    match run(root, &["restore", "--staged", "--", path]) {
        Ok(_) => Ok(()),
        // A repository without commits has no HEAD to restore from.
        Err(_) => run(root, &["rm", "--cached", "--quiet", "--", path]).map(|_| ()),
    }
}

pub fn stage_all(root: &Path) -> Result<(), String> {
    run(root, &["add", "--all"]).map(|_| ())
}

pub fn unstage_all(root: &Path) -> Result<(), String> {
    match run(root, &["reset", "--quiet"]) {
        Ok(_) => Ok(()),
        Err(_) => run(root, &["rm", "-r", "--cached", "--quiet", "--", "."]).map(|_| ()),
    }
}

pub fn commit(root: &Path, message: &str) -> Result<(), String> {
    let message = message.trim();

    if message.is_empty() {
        return Err("Write a commit message first.".into());
    }

    run(root, &["commit", "-m", message]).map(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    /// Short hash of the commit the tag points at.
    pub commit: String,
    /// Annotated tags carry a message, an author and a date of their own.
    pub annotated: bool,
    /// The tag message (annotated) or the tagged commit's subject.
    pub subject: String,
    /// ISO 8601 date the tag (or, for a lightweight tag, the commit) was made.
    pub date: String,
}

const MAX_TAGS: usize = 100;
const FIELD: char = '\u{1f}';

/// A tag name git accepts and that cannot be read as a command-line option.
fn check_tag_name(root: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Enter a tag name.".into());
    }

    if name.starts_with('-') || name.chars().any(char::is_whitespace) {
        return Err("A tag name cannot start with \"-\" or contain spaces.".into());
    }

    run(root, &["check-ref-format", &format!("refs/tags/{name}")])
        .map(|_| ())
        .map_err(|_| format!("\"{name}\" is not a valid tag name."))
}

fn tag_exists(root: &Path, name: &str) -> bool {
    run(
        root,
        &["rev-parse", "-q", "--verify", &format!("refs/tags/{name}")],
    )
    .is_ok()
}

fn parse_tags(raw: &str) -> Vec<GitTag> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(FIELD).collect();

            if fields.len() < 5 || fields[0].is_empty() {
                return None;
            }

            Some(GitTag {
                name: fields[0].to_string(),
                commit: fields[1].to_string(),
                annotated: fields[2] == "tag",
                date: fields[3].to_string(),
                subject: fields[4].to_string(),
            })
        })
        .collect()
}

/// The newest tags first. Annotated tags report the commit they point at,
/// not the tag object.
pub fn tags(root: &Path) -> Result<Vec<GitTag>, String> {
    let format = [
        "%(refname:short)",
        "%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)",
        "%(objecttype)",
        "%(creatordate:iso-strict)",
        "%(if)%(contents:subject)%(then)%(contents:subject)%(else)%(*subject)%(end)",
    ]
    .join("\u{1f}");

    let raw = run(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            &format!("--count={MAX_TAGS}"),
            &format!("--format={format}"),
            "refs/tags",
        ],
    )?;

    Ok(parse_tags(&raw))
}

/// Tags the current commit. A message makes it an annotated tag, which is
/// what release tooling usually expects; without one it is lightweight.
pub fn create_tag(root: &Path, name: &str, message: &str) -> Result<(), String> {
    let name = name.trim();
    check_tag_name(root, name)?;

    if run(root, &["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        return Err("Make a first commit before creating a tag.".into());
    }

    if tag_exists(root, name) {
        return Err(format!("A tag named \"{name}\" already exists."));
    }

    let message = message.trim();

    if message.is_empty() {
        run(root, &["tag", name])
    } else {
        run(root, &["tag", "-a", name, "-m", message])
    }
    .map(|_| ())
}

/// Pushes one tag to `origin`. Only that tag moves; branches are untouched.
pub fn push_tag(root: &Path, name: &str) -> Result<(), String> {
    let name = name.trim();
    check_tag_name(root, name)?;

    if !tag_exists(root, name) {
        return Err(format!("There is no tag named \"{name}\"."));
    }

    let remotes = run(root, &["remote"])?;

    if !remotes.split_whitespace().any(|remote| remote == "origin") {
        return Err("This repository has no origin remote to push the tag to.".into());
    }

    let refspec = format!("refs/tags/{name}:refs/tags/{name}");
    execute(root, &["push", "origin", &refspec], false).map(|_| ())
}

/// Deletes a tag from this repository only; a tag already pushed stays on
/// the remote.
pub fn delete_tag(root: &Path, name: &str) -> Result<(), String> {
    let name = name.trim();
    check_tag_name(root, name)?;

    if !tag_exists(root, name) {
        return Err(format!("There is no tag named \"{name}\"."));
    }

    run(root, &["tag", "-d", name]).map(|_| ())
}

/// Pushes the current branch to its upstream, or sets `origin` as the upstream
/// when the branch has none yet. Nothing is pulled, merged or rebased.
pub fn sync(root: &Path) -> Result<(), String> {
    let branch = run(root, &["branch", "--show-current"])?.trim().to_string();

    if branch.is_empty() {
        return Err("The repository is on a detached HEAD; check out a branch to sync.".into());
    }

    let upstream = execute(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        false,
    )
    .map(|name| name.trim().to_string())
    .unwrap_or_default();

    if !upstream.is_empty() {
        return execute(root, &["push"], false).map(|_| ());
    }

    let remotes = run(root, &["remote"])?;

    if !remotes.split_whitespace().any(|remote| remote == "origin") {
        return Err("This repository has no origin remote to sync with.".into());
    }

    execute(
        root,
        &["push", "--set-upstream", "origin", &branch],
        false,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_entries_become_staged_and_unstaged_changes() {
        let raw = "MM src/app.ts\0A  src/new.ts\0?? notes.md\0 D old.txt\0";

        let changes = parse_changes(raw);

        assert_eq!(changes.len(), 5);
        assert!(changes.iter().any(|change| change.path == "src/app.ts" && change.staged));
        assert!(changes.iter().any(|change| change.path == "src/app.ts" && !change.staged));
        assert!(changes.iter().any(|change| change.status == "U"));
        assert_eq!(
            changes
                .iter()
                .filter(|change| change.path == "src/new.ts")
                .count(),
            1
        );
    }

    #[test]
    fn parses_annotated_and_lightweight_tags() {
        let raw = "v1.1.0\u{1f}abc1234\u{1f}tag\u{1f}2026-11-26T10:00:00+00:00\u{1f}Release 1.1\n\
                   v1.0.0\u{1f}def5678\u{1f}commit\u{1f}2026-11-20T09:00:00+00:00\u{1f}Fix the build\n";
        let tags = parse_tags(raw);

        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "v1.1.0");
        assert!(tags[0].annotated);
        assert_eq!(tags[0].subject, "Release 1.1");
        assert_eq!(tags[1].commit, "def5678");
        assert!(!tags[1].annotated);
    }

    #[test]
    fn creates_lists_and_deletes_tags_in_a_real_repository() {
        let dir = std::env::temp_dir().join(format!(
            "nexium-tags-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| run(&dir, args);

        git(&["init", "-q"]).unwrap();
        git(&["config", "user.name", "Test"]).unwrap();
        git(&["config", "user.email", "test@example.com"]).unwrap();

        assert!(create_tag(&dir, "v0.1.0", "").is_err(), "no commit yet");

        std::fs::write(dir.join("a.txt"), "a").unwrap();
        git(&["add", "a.txt"]).unwrap();
        git(&["commit", "-q", "-m", "First"]).unwrap();

        create_tag(&dir, "v1.0.0", "").unwrap();
        create_tag(&dir, "v1.1.0", "Release 1.1").unwrap();
        assert!(create_tag(&dir, "v1.0.0", "").is_err(), "duplicate");
        assert!(create_tag(&dir, "-v2", "").is_err(), "option-like");
        assert!(create_tag(&dir, "bad name", "").is_err(), "space");
        assert!(create_tag(&dir, "v1..2", "").is_err(), "invalid ref");

        let listed = tags(&dir).unwrap();
        let names: Vec<&str> = listed.iter().map(|tag| tag.name.as_str()).collect();
        assert!(names.contains(&"v1.0.0") && names.contains(&"v1.1.0"));
        let annotated = listed.iter().find(|tag| tag.name == "v1.1.0").unwrap();
        assert!(annotated.annotated);
        assert_eq!(annotated.subject, "Release 1.1");
        let light = listed.iter().find(|tag| tag.name == "v1.0.0").unwrap();
        assert_eq!(light.subject, "First");
        assert_eq!(light.commit, annotated.commit);

        assert!(push_tag(&dir, "v1.0.0").unwrap_err().contains("no origin"));

        delete_tag(&dir, "v1.0.0").unwrap();
        assert!(tags(&dir).unwrap().iter().all(|tag| tag.name != "v1.0.0"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renames_skip_the_origin_entry() {
        let changes = parse_changes("R  new/name.rs\0old/name.rs\0");

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "new/name.rs");
        assert_eq!(changes[0].status, "R");
        assert!(changes[0].staged);
    }
}
