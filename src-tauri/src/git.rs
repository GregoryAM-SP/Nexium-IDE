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
    /// The remote branch the current one tracks, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// Commits on this branch that the upstream does not have yet (to push).
    pub ahead: u32,
    /// Commits on the upstream this branch does not have yet (to pull), as of
    /// the last fetch.
    pub behind: u32,
    /// The repository has at least one remote.
    pub has_remote: bool,
}

/// A local branch, or a remote one no local branch tracks yet.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// `feature/login`, or `origin/feature/login` for a remote branch.
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    /// The subject of its latest commit.
    pub subject: String,
    /// Its latest commit time, in seconds since 1970.
    pub updated: i64,
}

/// Extra environment for one git command: GitHub credentials, as
/// `GIT_CONFIG_*` variables, for commands that talk to the remote.
pub type Auth = [(String, String)];

fn execute(root: &Path, args: &[&str], allow_prompt: bool) -> Result<String, String> {
    execute_with(root, args, allow_prompt, &[])
}

fn execute_with(
    root: &Path,
    args: &[&str],
    allow_prompt: bool,
    auth: &Auth,
) -> Result<String, String> {
    // Fetch, pull and push update the same remote-tracking refs; two at once
    // (the background fetch and a click on Pull) fail with "cannot lock ref".
    // They take turns.
    static NETWORK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = matches!(args.first(), Some(&"fetch" | &"pull" | &"push"))
        .then(|| NETWORK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));

    let mut command = Command::new("git");

    command.arg("-C").arg(root).args(args);
    command.envs(auth.iter().map(|(key, value)| (key.as_str(), value.as_str())));

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
            upstream: None,
            ahead: 0,
            behind: 0,
            has_remote: false,
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

    let (upstream, ahead, behind) = tracking(root);

    Ok(GitStatus {
        is_repo: true,
        branch,
        changes: parse_changes(&raw),
        message: None,
        upstream,
        ahead,
        behind,
        has_remote: has_remote(root),
    })
}

fn has_remote(root: &Path) -> bool {
    run(root, &["remote"])
        .map(|remotes| !remotes.trim().is_empty())
        .unwrap_or(false)
}

fn upstream_of_head(root: &Path) -> Option<String> {
    execute(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        false,
    )
    .ok()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
}

/// The upstream and how far the branch is ahead of and behind it. Local only:
/// "behind" is as fresh as the last fetch.
fn tracking(root: &Path) -> (Option<String>, u32, u32) {
    let Some(upstream) = upstream_of_head(root) else {
        return (None, 0, 0);
    };

    let (ahead, behind) = run(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        .ok()
        .and_then(|counts| parse_counts(&counts))
        .unwrap_or((0, 0));

    (Some(upstream), ahead, behind)
}

fn parse_counts(raw: &str) -> Option<(u32, u32)> {
    let mut parts = raw.split_whitespace();
    let ahead = parts.next()?.parse().ok()?;
    let behind = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Updates the remote-tracking branches, so "behind" counts are current.
/// Quiet and non-interactive: a remote that needs a password just fails.
pub fn fetch(root: &Path, auth: &Auth) -> Result<(), String> {
    if !has_remote(root) {
        return Ok(());
    }

    execute_with(root, &["fetch", "--prune", "--quiet"], false, auth).map(|_| ())
}

/// Brings in the upstream's new commits, fast-forward only: it never makes a
/// merge commit or rewrites anything. If both sides have new commits, it
/// stops and says so.
pub fn pull(root: &Path, auth: &Auth) -> Result<(), String> {
    let branch = run(root, &["branch", "--show-current"])?.trim().to_string();

    if branch.is_empty() {
        return Err("The repository is on a detached HEAD; check out a branch to pull.".into());
    }

    let Some(upstream) = upstream_of_head(root) else {
        return Err(if has_remote(root) {
            format!("\"{branch}\" is not on the remote yet, so there is nothing to pull. Push it first.")
        } else {
            "This repository has no remote to pull from.".to_string()
        });
    };

    execute_with(root, &["pull", "--ff-only"], false, auth)
        .map(|_| ())
        .map_err(|error| {
            let lower = error.to_lowercase();
            if lower.contains("not possible to fast-forward") || lower.contains("diverg") {
                format!(
                    "\"{branch}\" and {upstream} both have new commits, so they cannot simply be fast-forwarded. Run `git pull --rebase` (or `git pull --no-rebase` to merge) in the terminal and resolve any conflicts there."
                )
            } else {
                error
            }
        })
}

/// Pushes the current branch (setting `origin` as its upstream the first
/// time). Never force-pushes.
pub fn push(root: &Path, auth: &Auth) -> Result<(), String> {
    sync(root, auth)
}

const BRANCH_FORMAT: &str = "%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(subject)%1f%(committerdate:unix)";

fn parse_branches(raw: &str) -> Vec<GitBranch> {
    let mut branches: Vec<GitBranch> = raw
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(FIELD).collect();

            if fields.len() < 6 || fields[0].ends_with("/HEAD") {
                return None;
            }

            let remote = fields[0].starts_with("refs/remotes/");
            // `origin/HEAD` shortens to plain `origin`; it is not a branch.
            if remote && !fields[1].contains('/') {
                return None;
            }

            Some(GitBranch {
                name: fields[1].to_string(),
                current: fields[2].trim() == "*",
                remote,
                upstream: Some(fields[3].to_string()).filter(|name| !name.is_empty()),
                subject: fields[4].to_string(),
                updated: fields[5].trim().parse().unwrap_or(0),
            })
        })
        .collect();

    // A remote branch already tracked by a local one would only be listed twice.
    let tracked: Vec<String> = branches
        .iter()
        .filter_map(|branch| branch.upstream.clone())
        .collect();
    branches.retain(|branch| !branch.remote || !tracked.contains(&branch.name));
    branches
}

/// Local branches, then remote ones no local branch tracks; newest first.
pub fn branches(root: &Path) -> Result<Vec<GitBranch>, String> {
    let raw = run(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={BRANCH_FORMAT}"),
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut list = parse_branches(&raw);
    list.sort_by_key(|branch| branch.remote);
    Ok(list)
}

fn check_branch_name(root: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Enter a branch name.".into());
    }

    if name.starts_with('-') || name.chars().any(char::is_whitespace) {
        return Err("A branch name cannot start with \"-\" or contain spaces.".into());
    }

    run(root, &["check-ref-format", "--branch", name])
        .map(|_| ())
        .map_err(|_| format!("\"{name}\" is not a valid branch name."))
}

fn branch_exists(root: &Path, name: &str) -> bool {
    run(root, &["rev-parse", "-q", "--verify", &format!("refs/heads/{name}")]).is_ok()
}

/// Creates a branch from the current commit and, when `checkout` is set,
/// switches to it (uncommitted changes come along).
pub fn create_branch(root: &Path, name: &str, checkout: bool) -> Result<(), String> {
    let name = name.trim();
    check_branch_name(root, name)?;

    if branch_exists(root, name) {
        return Err(format!("A branch named \"{name}\" already exists."));
    }

    if checkout {
        run(root, &["switch", "-c", name]).map(|_| ())
    } else {
        if run(root, &["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
            return Err("Make a first commit before creating a branch without switching to it.".into());
        }
        run(root, &["branch", name]).map(|_| ())
    }
}

/// Switches to a branch. A remote branch (`origin/feature`) is checked out as
/// a local branch that tracks it, or as the local branch of that name if one
/// exists. Git refuses if uncommitted changes would be overwritten.
pub fn switch_branch(root: &Path, name: &str, remote: bool) -> Result<(), String> {
    let name = name.trim();

    if name.is_empty() || name.starts_with('-') {
        return Err("Choose a branch to switch to.".into());
    }

    if !remote {
        if !branch_exists(root, name) {
            return Err(format!("There is no branch named \"{name}\"."));
        }
        return run(root, &["switch", name]).map(|_| ());
    }

    let Some((_, local)) = name.split_once('/') else {
        return Err(format!("\"{name}\" is not a remote branch."));
    };

    if branch_exists(root, local) {
        return run(root, &["switch", local]).map(|_| ());
    }

    run(root, &["switch", "--track", name]).map(|_| ())
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
pub fn push_tag(root: &Path, name: &str, auth: &Auth) -> Result<(), String> {
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
    execute_with(root, &["push", "origin", &refspec], false, auth).map(|_| ())
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
pub fn sync(root: &Path, auth: &Auth) -> Result<(), String> {
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
        return execute_with(root, &["push"], false, auth).map(|_| ());
    }

    let remotes = run(root, &["remote"])?;

    if !remotes.split_whitespace().any(|remote| remote == "origin") {
        return Err("This repository has no origin remote to sync with.".into());
    }

    execute_with(
        root,
        &["push", "--set-upstream", "origin", &branch],
        false,
        auth,
    )
    .map(|_| ())
}

// ── publishing a repository ─────────────────────────────────────────────────

pub fn is_repo(root: &Path) -> bool {
    run(root, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

/// Starts a repository in the folder, on `main`.
pub fn init(root: &Path) -> Result<(), String> {
    run(root, &["init", "-q", "-b", "main"]).map(|_| ())
}

pub fn has_commits(root: &Path) -> bool {
    run(root, &["rev-parse", "-q", "--verify", "HEAD"]).is_ok()
}

pub fn remote_url(root: &Path, name: &str) -> Option<String> {
    run(root, &["remote", "get-url", name])
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}

pub fn add_origin(root: &Path, url: &str) -> Result<(), String> {
    if url.starts_with('-') {
        return Err("That remote address is not valid.".into());
    }
    run(root, &["remote", "add", "origin", url]).map(|_| ())
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

        assert!(push_tag(&dir, "v1.0.0", &[]).unwrap_err().contains("no origin"));

        delete_tag(&dir, "v1.0.0").unwrap();
        assert!(tags(&dir).unwrap().iter().all(|tag| tag.name != "v1.0.0"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_branches_and_hides_tracked_remotes() {
        let f = FIELD;
        let raw = format!(
            "refs/heads/main{f}main{f}*{f}origin/main{f}Fix it{f}200\n\
             refs/heads/feature{f}feature{f} {f}{f}Start{f}100\n\
             refs/remotes/origin/HEAD{f}origin{f} {f}{f}Fix it{f}200\n\
             refs/remotes/origin/main{f}origin/main{f} {f}{f}Fix it{f}200\n\
             refs/remotes/origin/docs{f}origin/docs{f} {f}{f}Docs{f}150\n"
        );
        let list = parse_branches(&raw);
        let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["main", "feature", "origin/docs"]);
        assert!(list[0].current && !list[0].remote);
        assert_eq!(list[0].upstream.as_deref(), Some("origin/main"));
        assert!(list[2].remote);
        assert_eq!(list[2].updated, 150);
        assert_eq!(parse_counts("2\t5\n"), Some((2, 5)));
        assert_eq!(parse_counts(""), None);
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nexium-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn identify(dir: &Path) {
        run(dir, &["config", "user.name", "Test"]).unwrap();
        run(dir, &["config", "user.email", "test@example.com"]).unwrap();
    }

    #[test]
    fn pulls_pushes_and_counts_against_a_real_remote() {
        let base = scratch("remote");
        let origin = base.join("origin.git");
        let one = base.join("one");
        let two = base.join("two");
        std::fs::create_dir_all(&origin).unwrap();
        run(&origin, &["init", "-q", "--bare", "-b", "main"]).unwrap();

        // First clone: a commit on a new branch, pushed with --set-upstream.
        std::fs::create_dir_all(&one).unwrap();
        run(&one, &["init", "-q", "-b", "main"]).unwrap();
        identify(&one);
        run(&one, &["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();
        std::fs::write(one.join("a.txt"), "a").unwrap();
        run(&one, &["add", "a.txt"]).unwrap();
        run(&one, &["commit", "-q", "-m", "First"]).unwrap();
        assert!(pull(&one, &[]).unwrap_err().contains("not on the remote yet"));
        let before = status(&one).unwrap();
        assert!(before.has_remote && before.upstream.is_none());
        push(&one, &[]).unwrap();
        let pushed = status(&one).unwrap();
        assert_eq!(pushed.upstream.as_deref(), Some("origin/main"));
        assert_eq!((pushed.ahead, pushed.behind), (0, 0));

        // A local commit is one ahead.
        std::fs::write(one.join("b.txt"), "b").unwrap();
        run(&one, &["add", "b.txt"]).unwrap();
        run(&one, &["commit", "-q", "-m", "Second"]).unwrap();
        assert_eq!(status(&one).unwrap().ahead, 1);
        push(&one, &[]).unwrap();
        assert_eq!(status(&one).unwrap().ahead, 0);

        // Second clone pushes; the first sees it after a fetch, then pulls.
        run(&base, &["clone", "-q", origin.to_str().unwrap(), "two"]).unwrap();
        identify(&two);
        std::fs::write(two.join("c.txt"), "c").unwrap();
        run(&two, &["add", "c.txt"]).unwrap();
        run(&two, &["commit", "-q", "-m", "From two"]).unwrap();
        push(&two, &[]).unwrap();

        assert_eq!(status(&one).unwrap().behind, 0, "not fetched yet");
        fetch(&one, &[]).unwrap();
        assert_eq!(status(&one).unwrap().behind, 1);
        pull(&one, &[]).unwrap();
        assert!(one.join("c.txt").exists());
        assert_eq!(status(&one).unwrap().behind, 0);

        // Both sides move on: the pull refuses instead of merging.
        std::fs::write(two.join("d.txt"), "d").unwrap();
        run(&two, &["add", "d.txt"]).unwrap();
        run(&two, &["commit", "-q", "-m", "Two again"]).unwrap();
        push(&two, &[]).unwrap();
        std::fs::write(one.join("e.txt"), "e").unwrap();
        run(&one, &["add", "e.txt"]).unwrap();
        run(&one, &["commit", "-q", "-m", "One again"]).unwrap();
        fetch(&one, &[]).unwrap();
        let diverged = status(&one).unwrap();
        assert_eq!((diverged.ahead, diverged.behind), (1, 1));
        assert!(pull(&one, &[]).unwrap_err().contains("both have new commits"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn creates_and_switches_branches() {
        let base = scratch("branches");
        let origin = base.join("origin.git");
        let work = base.join("work");
        std::fs::create_dir_all(&origin).unwrap();
        run(&origin, &["init", "-q", "--bare", "-b", "main"]).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        run(&work, &["init", "-q", "-b", "main"]).unwrap();
        identify(&work);
        run(&work, &["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();

        // Before the first commit a branch can only be created by switching.
        assert!(create_branch(&work, "early", false).unwrap_err().contains("first commit"));

        std::fs::write(work.join("a.txt"), "a").unwrap();
        run(&work, &["add", "a.txt"]).unwrap();
        run(&work, &["commit", "-q", "-m", "First"]).unwrap();
        push(&work, &[]).unwrap();

        create_branch(&work, "feature/login", true).unwrap();
        assert_eq!(status(&work).unwrap().branch, "feature/login");
        assert!(create_branch(&work, "feature/login", true).unwrap_err().contains("already exists"));
        assert!(create_branch(&work, "bad name", true).is_err());
        assert!(create_branch(&work, "-x", true).is_err());
        assert!(create_branch(&work, "a..b", true).is_err());

        create_branch(&work, "later", false).unwrap();
        assert_eq!(status(&work).unwrap().branch, "feature/login", "created without switching");

        // Uncommitted changes come along to a new branch.
        std::fs::write(work.join("draft.txt"), "draft").unwrap();
        switch_branch(&work, "main", false).unwrap();
        assert_eq!(status(&work).unwrap().branch, "main");
        assert!(work.join("draft.txt").exists());
        assert!(switch_branch(&work, "nope", false).is_err());

        // A branch only on the remote is checked out as a tracking branch.
        run(&work, &["push", "-q", "origin", "main:refs/heads/docs"]).unwrap();
        fetch(&work, &[]).unwrap();
        let listed = branches(&work).unwrap();
        assert!(listed.iter().any(|b| b.name == "origin/docs" && b.remote));
        assert!(!listed.iter().any(|b| b.name == "origin/main"), "tracked by main");
        assert!(listed.iter().any(|b| b.name == "main" && b.current));
        switch_branch(&work, "origin/docs", true).unwrap();
        let now = status(&work).unwrap();
        assert_eq!(now.branch, "docs");
        assert_eq!(now.upstream.as_deref(), Some("origin/docs"));

        let _ = std::fs::remove_dir_all(&base);
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
