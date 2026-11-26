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
    fn renames_skip_the_origin_entry() {
        let changes = parse_changes("R  new/name.rs\0old/name.rs\0");

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "new/name.rs");
        assert_eq!(changes[0].status, "R");
        assert!(changes[0].staged);
    }
}
