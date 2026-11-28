use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures::future::{select, Either};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use crate::command;
use crate::llm;
use crate::llm::{ChatMessage, Endpoint};
use crate::run::{self, RunContext};
use crate::store::{self, ClaimResult};
use crate::workspace;

const MAX_STEPS: usize = 30;
/// While objectives are open and the run keeps making progress, it may go on
/// past MAX_STEPS up to this many turns, so a long task is finished in one go.
const MAX_STEPS_WITH_OBJECTIVES: usize = 120;
/// Turns without a successful tool call before an open-objective run stops.
const MAX_TURNS_WITHOUT_PROGRESS: usize = 12;
/// Times one reply may be continued after it was cut off.
const MAX_CONTINUATIONS: usize = 4;
/// Times the model is sent back to work when it stops with objectives open.
const MAX_OBJECTIVE_NUDGES: usize = 2;
/// Retries of a request that failed before the model sent anything.
const MAX_RETRIES: usize = 2;
/// How long a run keeps waiting out a provider's rate limit (or overload)
/// before it gives up. Stop ends the wait at any time.
const RATE_LIMIT_PATIENCE: Duration = Duration::from_secs(15 * 60);
/// Waits between attempts when the provider does not say how long to wait.
const RATE_LIMIT_BACKOFF: [u64; 6] = [5, 10, 20, 30, 45, 60];
/// Reply tokens asked for per turn.
const REPLY_TOKENS: u64 = 4096;
/// Longest objectives list the agent may keep for one task.
const MAX_OBJECTIVES: usize = 12;
const MAX_OBJECTIVE_CHARS: usize = 140;
const MAX_TOOL_CONTENT: usize = 40_000;
const MAX_WRITE_CHARS: usize = 200_000;
/// How often a run waiting on the user's Accept/Reject checks for an answer.
const APPROVAL_POLL: Duration = Duration::from_millis(120);
const REJECTED: &str = "The user rejected this change, so the file was left as it was. Do not retry the same change; ask what they would like instead, or take a different approach.";
const REJECTED_COMMAND: &str = "The user rejected this command, so it did not run. Do not run it again; use a different command, or finish without it and say what you could not check.";

/// Decisions on proposed changes and commands, keyed by session and the step
/// that proposed them. The UI's buttons fill it in through `agent_decide`.
pub type Approvals = Mutex<HashMap<(String, usize), bool>>;

/// Tools that exist only when sessions can coordinate through the database.
const SESSION_TOOLS: [&str; 2] = ["session_status", "message_sessions"];

#[derive(Serialize, Clone)]
pub struct AgentStep {
    pub id: usize,
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    pub status: String,
    /// The tool behind a `tool` step, so the UI can pick an icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// The workspace file the step is about, so the UI can link to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The checklist, on the one `objectives` step a run keeps up to date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objectives: Option<Vec<Objective>>,
}

/// One goal on the checklist the agent keeps for a multi-step task.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Objective {
    pub title: String,
    /// pending | in_progress | done
    pub status: String,
}

/// A proposed write (shown as a diff) or command, waiting on the user.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    /// `change` or `command`.
    kind: String,
    step_id: usize,
    path: String,
    before: String,
    after: String,
    created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
}

struct Change {
    path: String,
    before: Option<String>,
    after: String,
}

#[derive(Serialize)]
pub struct AgentReply {
    pub text: String,
    pub reasoning: Option<String>,
    pub steps: Vec<AgentStep>,
    pub tools_enabled: bool,
    /// The run spent every tool step; the UI offers to continue.
    pub out_of_steps: bool,
}

#[derive(Serialize, Clone)]
struct DeltaPayload {
    kind: String,
    text: String,
}

#[derive(Default, Clone)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct StreamedTurn {
    content: String,
    reasoning: String,
    tool_calls: Vec<ToolCall>,
    /// `stop`, `tool_calls`, `length` (cut off by max_tokens), or
    /// `interrupted` (the connection dropped after the model started).
    finish_reason: String,
}

impl StreamedTurn {
    /// The reply ended before the model finished it.
    fn cut_off(&self) -> bool {
        matches!(self.finish_reason.as_str(), "length" | "interrupted")
    }
}

fn make_step(
    id: usize,
    kind: &str,
    title: String,
    detail: Option<String>,
    status: &str,
) -> AgentStep {
    AgentStep {
        id,
        kind: kind.to_string(),
        title,
        detail,
        status: status.to_string(),
        tool: None,
        path: None,
        objectives: None,
    }
}

fn truncate(value: String, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value;
    }

    let mut clipped: String = value.chars().take(limit).collect();
    clipped.push_str("\n… truncated");
    clipped
}

fn summarize(value: &str) -> String {
    let first = value.lines().next().unwrap_or("").trim();
    first.chars().take(120).collect()
}

fn tool_schema() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "set_objectives",
                "description": "Plan and track a multi-step task as a checklist the user sees with live progress. Call it FIRST, before reading files, whenever a request needs more than one change or touches more than one file; then call it again with the complete list each time an objective starts (in_progress) or finishes (done). Not for questions or a single small edit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "objectives": {
                            "type": "array",
                            "description": "Every objective for the task, in order.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {
                                        "type": "string",
                                        "description": "A short outcome, e.g. \"Add a dark theme toggle to settings\"."
                                    },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "done"]
                                    }
                                },
                                "required": ["title", "status"]
                            }
                        }
                    },
                    "required": ["objectives"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files and folders inside the open workspace folder. Use it to explore before reading.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Folder path relative to the workspace root. Use \"\" for the root."
                        }
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file from the workspace. Always read a file before editing it. For a long file, read the part you need with start_line and end_line (search_text gives line numbers).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path relative to the workspace root, e.g. src/App.tsx."
                        },
                        "start_line": {
                            "type": "integer",
                            "description": "Optional first line to return (1-based)."
                        },
                        "end_line": {
                            "type": "integer",
                            "description": "Optional last line to return (inclusive)."
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create a new file, or replace a whole file when most of it changes. The content replaces the entire file, so include everything that should remain. For targeted changes to an existing file use edit_file instead. The user reviews every write before it is saved.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path relative to the workspace root."
                        },
                        "content": {
                            "type": "string",
                            "description": "The complete new contents of the file."
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Change part of an existing file by replacing an exact piece of text. old_string must match the file exactly, including indentation, and must be unique unless replace_all is true; include a few surrounding lines to make it unique. Read the file first. The user reviews every edit before it is saved.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path relative to the workspace root."
                        },
                        "old_string": {
                            "type": "string",
                            "description": "The exact text to replace, copied from the file."
                        },
                        "new_string": {
                            "type": "string",
                            "description": "The text to put in its place."
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "Replace every occurrence instead of exactly one. Defaults to false."
                        }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_text",
                "description": "Search the workspace for text (case-insensitive) and return matching file:line results.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Text to search for."
                        },
                        "path": {
                            "type": "string",
                            "description": "Optional folder to limit the search to, relative to the workspace root."
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace folder and get its output and exit code: use it to run the project's tests, type-check, build or lint and check your work. Windows runs it with cmd.exe, other systems with sh. It is non-interactive (no input) and stopped at the time limit. Never start servers, watchers or interactive programs, and nothing that deletes data, installs globally, commits, pushes or deploys unless the user asked. The user approves each command.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The command line, e.g. \"npm test -- --run\" or \"cargo check\"."
                        },
                        "timeout_seconds": {
                            "type": "integer",
                            "description": "Optional time limit (default 120, maximum 600)."
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "session_status",
                "description": "See what the other assistant sessions on this project are doing right now: which are running, their open objectives, the files they have locked, and their recent changes and notes.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "message_sessions",
                "description": "Leave a short note for the other assistant sessions on this project, e.g. that you renamed a function or changed a signature they use, or that you need a file they have locked. They see it in their next step.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": { "type": "string", "description": "The note, one or two sentences." }
                    },
                    "required": ["message"]
                }
            }
        }
    ])
}

fn argument<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(|value| value.as_str()).unwrap_or("")
}

fn describe_call(name: &str, args: &Value) -> String {
    match name {
        "list_files" => {
            let path = argument(args, "path");
            if path.is_empty() {
                "Listing the workspace".to_string()
            } else {
                format!("Listing {path}")
            }
        }
        "read_file" => format!("Reading {}", argument(args, "path")),
        "write_file" => format!("Writing {}", argument(args, "path")),
        "edit_file" => format!("Editing {}", argument(args, "path")),
        "search_text" => format!("Searching for \"{}\"", argument(args, "query")),
        "run_command" => format!("Running `{}`", summarize(argument(args, "command"))),
        "session_status" => "Checking the other sessions".to_string(),
        "message_sessions" => "Messaging the other sessions".to_string(),
        other => format!("Calling {other}"),
    }
}

/// The key a file is tracked under: forward slashes, no leading `./`.
fn path_key(path: &str) -> String {
    path.trim().replace('\\', "/").trim_start_matches("./").to_string()
}

fn content_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// `read_file`: the whole file, or the requested lines. The full file's hash
/// is remembered so a later rewrite can tell if someone changed it meanwhile.
fn read_file(root: &Path, args: &Value, read: &mut HashMap<String, u64>) -> Result<String, String> {
    let path = argument(args, "path");
    let content = workspace::read(root, path)?;
    read.insert(path_key(path), content_hash(&content));

    let start = args.get("start_line").and_then(Value::as_u64);
    let end = args.get("end_line").and_then(Value::as_u64);

    if start.is_none() && end.is_none() {
        return Ok(content);
    }

    Ok(line_range(&content, start.unwrap_or(1), end))
}

fn line_range(content: &str, start: u64, end: Option<u64>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u64;
    let first = start.max(1);
    let last = end.unwrap_or(total).min(total);

    if total == 0 || first > last {
        return format!("[The file has {total} lines; that range is empty.]");
    }

    format!(
        "[Lines {first}-{last} of {total}]\n{}",
        lines[(first - 1) as usize..last as usize].join("\n")
    )
}

fn execute_tool(root: &Path, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "list_files" => workspace::list(root, argument(args, "path"), 400),
        "search_text" => workspace::search(root, argument(args, "path"), argument(args, "query"), 120),
        other => Err(format!("Unknown tool '{other}'.")),
    }
}

/// Reads a `set_objectives` call. Models vary in how strictly they follow the
/// schema, so plain strings, a JSON-encoded list and loose status words are
/// accepted too.
fn parse_objectives(args: &Value) -> Result<Vec<Objective>, String> {
    let raw = args.get("objectives").cloned().unwrap_or(Value::Null);
    let raw = match raw {
        Value::String(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
        other => other,
    };
    let items = raw
        .as_array()
        .ok_or("objectives must be a list of { title, status } objects.")?;

    let mut objectives = Vec::new();

    for item in items {
        let (title, status) = match item {
            Value::String(title) => (title.as_str(), "pending"),
            other => (argument(other, "title"), argument(other, "status")),
        };

        let title: String = title
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(MAX_OBJECTIVE_CHARS)
            .collect();

        if title.is_empty() {
            continue;
        }

        let status = match status.trim().to_ascii_lowercase().replace([' ', '-'], "_").as_str() {
            "done" | "complete" | "completed" | "finished" => "done",
            "in_progress" | "active" | "doing" | "started" | "running" => "in_progress",
            _ => "pending",
        };

        objectives.push(Objective {
            title,
            status: status.to_string(),
        });

        if objectives.len() == MAX_OBJECTIVES {
            break;
        }
    }

    if objectives.is_empty() {
        return Err("Give at least one objective with a title.".into());
    }

    Ok(objectives)
}

/// What the model is told after it updates its checklist.
fn objectives_report(objectives: &[Objective]) -> String {
    let done = objectives.iter().filter(|o| o.status == "done").count();
    let lines: Vec<String> = objectives
        .iter()
        .map(|o| format!("- [{}] {}", o.status, o.title))
        .collect();

    format!(
        "Objectives updated ({done} of {} done):\n{}\nKeep the list current as you work, and send the whole list each time.",
        objectives.len(),
        lines.join("\n")
    )
}

/// Tool calls without a checklist update before the model is reminded of it.
const OBJECTIVES_REMINDER_AFTER: usize = 3;

/// A note added to a tool result while objectives are open: after every change
/// (which often finishes one) and after a few other calls. Smaller models
/// otherwise keep working and never tick anything off.
fn objectives_reminder(
    objectives: &[Objective],
    changed_a_file: bool,
    calls_since_update: usize,
) -> Option<String> {
    let open: Vec<&Objective> = objectives.iter().filter(|o| o.status != "done").collect();

    if open.is_empty() || (!changed_a_file && calls_since_update < OBJECTIVES_REMINDER_AFTER) {
        return None;
    }

    let done = objectives.len() - open.len();
    let current = open
        .iter()
        .find(|o| o.status == "in_progress")
        .map(|o| format!(" In progress: \"{}\".", o.title))
        .unwrap_or_default();

    Some(format!(
        "[Objectives: {done} of {} done.{current} If this finished an objective or you are moving to the next one, call set_objectives with the updated list now.]",
        objectives.len()
    ))
}

/// The step that carries the checklist to the UI.
fn objectives_card(id: usize, objectives: Vec<Objective>) -> AgentStep {
    let done = objectives.iter().filter(|o| o.status == "done").count();
    let mut step = make_step(
        id,
        "objectives",
        format!("{done} of {} objectives done", objectives.len()),
        None,
        "done",
    );
    step.objectives = Some(objectives);
    step
}

fn is_change(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file")
}

/// Replaces `old` with `new` in `current`, refusing anything ambiguous so a
/// model can never edit a different spot than the one it meant.
fn apply_edit(current: &str, old: &str, new: &str, all: bool) -> Result<String, String> {
    if old.is_empty() {
        return Err("old_string is empty. Copy the exact text to replace from read_file.".into());
    }

    // Files saved on Windows often use CRLF while models write plain LF.
    let (old, new) = if !current.contains(old) && current.contains("\r\n") && !old.contains('\r') {
        (old.replace('\n', "\r\n"), new.replace('\n', "\r\n"))
    } else {
        (old.to_string(), new.to_string())
    };

    match current.matches(old.as_str()).count() {
        0 => Err("old_string was not found. Read the file again and copy the exact text, including indentation.".into()),
        1 => Ok(current.replacen(old.as_str(), &new, 1)),
        _ if all => Ok(current.replace(old.as_str(), &new)),
        count => Err(format!(
            "old_string matches {count} places. Include more surrounding lines so it is unique, or set replace_all."
        )),
    }
}

/// Works out what a write_file or edit_file call would leave on disk, without
/// touching it, so the change can be reviewed first.
fn prepare_change(root: &Path, name: &str, args: &Value) -> Result<Change, String> {
    let path = argument(args, "path").trim().to_string();

    if path.is_empty() {
        return Err(format!("{name} needs a path."));
    }

    let target = workspace::safe_join(root, &path)?;
    let before = if target.is_file() {
        Some(workspace::read(root, &path)?)
    } else {
        None
    };

    let after = match name {
        "write_file" => argument(args, "content").to_string(),
        "edit_file" => {
            let Some(current) = before.as_deref() else {
                return Err(format!("{path} does not exist. Use write_file to create it."));
            };
            let all = args
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            apply_edit(
                current,
                argument(args, "old_string"),
                argument(args, "new_string"),
                all,
            )
            .map_err(|error| format!("{path}: {error}"))?
        }
        other => return Err(format!("Unknown tool '{other}'.")),
    };

    if after.chars().count() > MAX_WRITE_CHARS {
        return Err(format!(
            "That file would be too large ({MAX_WRITE_CHARS} characters maximum). Split it up."
        ));
    }

    if before.as_deref() == Some(after.as_str()) {
        return Err(format!("That change would leave {path} exactly as it is."));
    }

    Ok(Change {
        path,
        before,
        after,
    })
}

/// Lines added and removed, counted outside the unchanged head and tail.
fn line_stats(before: &str, after: &str) -> (usize, usize) {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let head = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();

    (new.len() - head - tail, old.len() - head - tail)
}

/// Shows the change to the user and, once accepted (or straight away when
/// edits are auto-approved), writes it. A rejection comes back as the tool's
/// error so the model knows to stop and ask.
/// Shows the request to the user and waits for Accept (Ok) or Reject
/// (`REJECTED`); Stop ends the wait.
async fn wait_for_approval(
    app: &RunContext,
    step: &AgentStep,
    request: ApprovalRequest,
    approvals: &Approvals,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let key = (app.session.clone(), step.id);

    if let Ok(mut pending) = approvals.lock() {
        pending.remove(&key);
    }

    let mut awaiting = step.clone();
    awaiting.status = "awaiting".into();
    let _ = app.emit("agent-step", awaiting);
    let _ = app.emit("agent-approval", request);

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled.message());
        }

        let decision = approvals.lock().ok().and_then(|mut pending| pending.remove(&key));

        match decision {
            Some(true) => return Ok(()),
            Some(false) => return Err(REJECTED.into()),
            None => tokio::time::sleep(APPROVAL_POLL).await,
        }
    }
}

/// Why a whole-file rewrite must not go ahead, if it must not: the file exists
/// but this run never read it, or it changed since the read.
fn stale_write(path: &str, before: Option<&str>, read: &HashMap<String, u64>) -> Option<String> {
    let before = before?;

    match read.get(&path_key(path)) {
        None => Some(format!(
            "{path} already exists and you have not read it in this task. Read it first, then change it with edit_file (or rewrite it with write_file if most of it changes)."
        )),
        Some(hash) if *hash != content_hash(before) => Some(format!(
            "{path} changed since you read it (another session or the user edited it). Read it again and build on the current version."
        )),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn apply_change(
    root: &Path,
    app: &RunContext,
    name: &str,
    args: &Value,
    step: &AgentStep,
    auto_approve: bool,
    approvals: &Approvals,
    cancel: &AtomicBool,
    read: &mut HashMap<String, u64>,
    objective: Option<&str>,
) -> Result<String, String> {
    let change = prepare_change(root, name, args)?;
    let key = path_key(&change.path);

    if name == "write_file" {
        if let Some(reason) = stale_write(&change.path, change.before.as_deref(), read) {
            return Err(reason);
        }
    }

    // A file another running session is editing is theirs until it finishes.
    if let Some(store) = &app.store {
        if let ClaimResult::Held(claim) =
            store.claim(&app.project, &key, &app.session, |id| app.is_running(id))?
        {
            return Err(format!(
                "{} is being edited right now by another session, \"{}\", so it is locked. Do not edit it: work on other files first, read it to stay compatible, call session_status to see what that session is doing, or use message_sessions to ask it for what you need.",
                change.path, claim.session_title
            ));
        }
    }

    let created = change.before.is_none();
    let before = change.before.unwrap_or_default();

    if !auto_approve {
        wait_for_approval(
            app,
            step,
            ApprovalRequest {
                kind: "change".into(),
                step_id: step.id,
                path: change.path.clone(),
                before: before.clone(),
                after: change.after.clone(),
                created,
                command: None,
            },
            approvals,
            cancel,
        )
        .await?;
    }

    workspace::write(root, &change.path, &change.after)?;
    read.insert(key.clone(), content_hash(&change.after));
    app.record("change", Some(&key), objective.unwrap_or(""));
    let (added, removed) = line_stats(&before, &change.after);

    Ok(format!(
        "{} {} (+{added} −{removed} lines).",
        if created { "Created" } else { "Updated" },
        change.path
    ))
}

#[allow(clippy::too_many_arguments)]
async fn run_command_tool(
    root: &Path,
    app: &RunContext,
    args: &Value,
    step: &AgentStep,
    auto_approve: bool,
    approvals: &Approvals,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let line = argument(args, "command").trim().to_string();

    if line.is_empty() {
        return Err("run_command needs a command.".into());
    }

    let timeout = args
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(command::DEFAULT_TIMEOUT)
        .clamp(1, command::MAX_TIMEOUT);

    if !auto_approve {
        wait_for_approval(
            app,
            step,
            ApprovalRequest {
                kind: "command".into(),
                step_id: step.id,
                path: String::new(),
                before: String::new(),
                after: String::new(),
                created: false,
                command: Some(line.clone()),
            },
            approvals,
            cancel,
        )
        .await
        .map_err(|error| if error == REJECTED { REJECTED_COMMAND.to_string() } else { error })?;
    }

    let outcome = command::run(root, &line, timeout, cancel).await?;
    Ok(outcome.report(&line, timeout))
}

/// The status line of a command's report: "[exit code 0]".
fn command_status(report: &str) -> String {
    report
        .lines()
        .last()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_string()
}

/// Changes and notes other sessions made since `last_seen`, for the model,
/// with a warning about files this run read that they changed.
fn news_from_others(
    app: &RunContext,
    last_seen: &mut i64,
    read: &HashMap<String, u64>,
) -> Option<String> {
    let store = app.store.as_ref()?;
    let entries = store
        .activity_from_others(&app.project, &app.session, *last_seen, 20)
        .ok()?;
    *last_seen = entries.last()?.id;
    news_text(&entries, read, store::now())
}

fn news_text(entries: &[store::Activity], read: &HashMap<String, u64>, now: i64) -> Option<String> {
    let mut lines: Vec<String> = entries
        .iter()
        .filter(|entry| entry.kind == "change" || entry.kind == "note")
        .map(|entry| run::describe_activity(entry, now))
        .collect();

    if lines.is_empty() {
        return None;
    }

    let mut touched: Vec<&str> = entries
        .iter()
        .filter(|entry| entry.kind == "change")
        .filter_map(|entry| entry.path.as_deref())
        .filter(|path| read.contains_key(*path))
        .collect();
    touched.dedup();

    if !touched.is_empty() {
        lines.push(format!(
            "You read {} earlier in this task: read it again before editing it, and keep your work compatible with their change.",
            touched.join(", ")
        ));
    }

    Some(format!("[Update from other sessions]\n{}", lines.join("\n")))
}

/// Files whose changes are worth checking with the project's tools; prose and
/// data files are not.
fn is_code_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    !matches!(
        extension,
        "md" | "mdx" | "markdown" | "txt" | "rst" | "adoc" | "csv" | "log" | "png" | "jpg" | "jpeg" | "gif" | "svg" | "ico"
    ) && !lower.ends_with("license")
}

const VERIFY_PROMPT: &str = "Before you finish: you changed code but have not checked it yet. Run the project's relevant checks with run_command (its tests, type-check, build or lint, whichever it has) and fix anything that fails. If the project has no checks you can run, re-read the parts you changed once and fix any mistake. Then give your final answer, including how you verified the change.";

fn policy(root: &Path, others: &str) -> String {
    let listing = workspace::list(root, "", 200).unwrap_or_else(|_| "(unavailable)".into());

    let folder = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string());

    let os = std::env::consts::OS;
    let shell = if cfg!(windows) { "cmd.exe" } else { "sh" };
    let mut text = format!(
        "You are the assistant inside Nexium Studio, a local code editor, working in the folder \"{folder}\". \
         Work like a careful senior engineer: finish what you start, check your work, and fit in with the code that is already there.\n\n\
         How to work on a change:\n\
         1. Understand: find the relevant code first (search_text, list_files, read_file) and read enough to follow the existing structure, names, style and patterns. Never invent file contents or APIs; check how things are used elsewhere.\n\
         2. Plan: when a request needs more than one change or touches more than one file, your FIRST tool call is set_objectives with 2-6 short, outcome-focused objectives, before reading anything. \
         Mark each objective in_progress when you start it and done as soon as it is finished, calling set_objectives with the whole list each time; add or drop objectives if the plan changes. \
         Do not use objectives for questions, explanations or a single small edit.\n\
         3. Change: make focused edits that fit the codebase. To change an existing file use edit_file with an exact, unique old_string; use write_file only for new files or full rewrites, and only after reading the file. \
         Don't reformat, rename or refactor code you were not asked to touch, and keep behaviour you were not asked to change.\n\
         4. Verify: after changing code, run the project's own checks with run_command (tests, type-check, build or lint, whichever it has: look at package.json scripts, Cargo.toml, Makefile, pyproject.toml and so on). \
         Prefer quick, targeted commands, and fix what fails. Commands run on {os} through {shell}, so use that shell's syntax; run_command already has a time limit.\n\
         5. Finish: carry the task through to the end in this reply. Never stop part-way to ask whether to continue, and do not end with a plan of what you will do next; do it. \
         Then summarise what you changed (with file paths), how you verified it, and anything left open.\n\n\
         The user reviews each edit and command and may reject it. If something is rejected, do not repeat it; take a different approach or ask what they want.\n\
         For questions, answer from the code you read and cite `path:line`. When the message already contains the code to look at, answer directly instead of exploring the folder first.\n\
         Write answers in Markdown, short and concrete, with code in fenced blocks tagged with the language. If a request is ambiguous, ask one short question instead of guessing.\n"
    );

    if !others.is_empty() {
        text.push_str(
            "\nThe user can run several assistant sessions on this project at the same time. A file another running session is editing is locked to it. \
             Build on the other sessions' recent changes: do not undo, rewrite or refactor their work unless the user asks. Before editing a file another session changed recently, read its current version. \
             Use session_status to see what they are doing now, and message_sessions to tell them about a change that affects them (for example a renamed function or a changed signature).\n\n",
        );
        text.push_str(others);
        text.push('\n');
    }

    text.push_str(&format!("\nCurrent workspace listing:\n{}", truncate(listing, 6_000)));
    text
}

/// Extracts the JSON payload of an SSE `data:` line.
fn parse_sse_line(line: &str) -> Option<Value> {
    let line = line.trim_end_matches(['\r', '\n']);

    if line.is_empty() || line.starts_with(':') {
        return None;
    }

    let data = line.strip_prefix("data:")?.trim();

    if data.is_empty() || data == "[DONE]" {
        return None;
    }

    serde_json::from_str::<Value>(data).ok()
}

/// Folds one streaming delta into the turn and reports text that should be
/// forwarded to the UI. Tool calls arrive as fragments spread over many deltas.
fn apply_delta(
    delta: &Value,
    turn: &mut StreamedTurn,
    calls: &mut Vec<Option<ToolCall>>,
) -> Vec<DeltaPayload> {
    let mut emitted = Vec::new();

    if let Some(text) = delta.get("content").and_then(|value| value.as_str()) {
        if !text.is_empty() {
            turn.content.push_str(text);
            emitted.push(DeltaPayload {
                kind: "content".into(),
                text: text.to_string(),
            });
        }
    }

    // NVIDIA, DeepSeek and most others stream `reasoning_content`; Ollama and
    // OpenRouter call the same thing `reasoning`.
    if let Some(thought) = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(|value| value.as_str())
    {
        if !thought.is_empty() {
            turn.reasoning.push_str(thought);
            emitted.push(DeltaPayload {
                kind: "reasoning".into(),
                text: thought.to_string(),
            });
        }
    }

    if let Some(partial) = delta.get("tool_calls").and_then(|value| value.as_array()) {
        for entry in partial {
            let index = entry.get("index").and_then(|value| value.as_u64()).unwrap_or(0) as usize;

            while calls.len() <= index {
                calls.push(None);
            }

            let slot = calls[index].get_or_insert_with(ToolCall::default);

            if let Some(id) = entry.get("id").and_then(|value| value.as_str()) {
                if !id.is_empty() {
                    slot.id = id.to_string();
                }
            }

            if let Some(function) = entry.get("function") {
                if let Some(name) = function.get("name").and_then(|value| value.as_str()) {
                    if !name.is_empty() && !slot.name.contains(name) {
                        slot.name.push_str(name);
                    }
                }

                if let Some(args) = function.get("arguments").and_then(|value| value.as_str()) {
                    slot.arguments.push_str(args);
                }
            }
        }
    }

    emitted
}

fn turn_from_message(message: &Value) -> StreamedTurn {
    let mut turn = StreamedTurn {
        content: message
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        reasoning: message
            .get("reasoning_content")
            .or_else(|| message.get("reasoning"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        tool_calls: Vec::new(),
        finish_reason: String::new(),
    };

    if let Some(calls) = message.get("tool_calls").and_then(|value| value.as_array()) {
        for call in calls {
            let function = call.get("function").cloned().unwrap_or_else(|| json!({}));

            turn.tool_calls.push(ToolCall {
                id: call
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("call_0")
                    .to_string(),
                name: function
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                arguments: match function.get("arguments") {
                    Some(Value::String(text)) => text.clone(),
                    Some(object @ Value::Object(_)) => object.to_string(),
                    _ => "{}".to_string(),
                },
            });
        }
    }

    turn
}

enum Failure {
    Transport(String),
    Http {
        status: u16,
        message: String,
        /// Seconds the provider asked to wait (`Retry-After`), if it said.
        retry_after: Option<u64>,
    },
    EmptyStream,
    Cancelled,
}

/// How often the streaming loop checks for a Stop press while NVIDIA is silent.
const CANCEL_POLL: Duration = Duration::from_millis(400);

impl Failure {
    fn message(self) -> String {
        match self {
            Failure::Transport(message) => message,
            Failure::Http { message, .. } => message,
            Failure::EmptyStream => {
                "NVIDIA NIM accepted the request but streamed nothing back.".to_string()
            }
            Failure::Cancelled => "Stopped.".to_string(),
        }
    }

    /// Only a rejected tool schema means the model cannot use tools; a network
    /// or timeout problem must not be reported as a missing capability.
    fn tools_rejected(&self) -> bool {
        matches!(self, Failure::Http { status: 400 | 422, .. })
    }
}

async fn stream_turn(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    body: &Value,
    app: &RunContext,
    cancel: &AtomicBool,
) -> Result<StreamedTurn, Failure> {
    let response = endpoint
        .post(client, "chat/completions")
        .header("Accept", "text/event-stream")
        .json(body)
        .send()
        .await
        .map_err(|error| Failure::Transport(llm::transport_error(&endpoint.name, &error)))?;

    let status = response.status().as_u16();

    if !(200..=299).contains(&status) {
        let retry_after = retry_after(&response);
        let detail = llm::read_detail(response).await;
        return Err(Failure::Http {
            status,
            message: llm::describe(&endpoint.name, status, detail.as_deref()),
            retry_after,
        });
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut turn = StreamedTurn::default();
    let mut calls: Vec<Option<ToolCall>> = Vec::new();
    let mut idle = Box::pin(tokio::time::sleep(CANCEL_POLL));

    loop {
        // Racing the stream against a timer keeps Stop responsive even while the
        // model is silent for minutes.
        let chunk = match select(stream.next(), idle).await {
            Either::Left((chunk, next_idle)) => {
                idle = next_idle;
                chunk
            }
            Either::Right(((), _)) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(Failure::Cancelled);
                }

                idle = Box::pin(tokio::time::sleep(CANCEL_POLL));
                continue;
            }
        };

        let Some(chunk) = chunk else {
            break;
        };

        let bytes = match chunk {
            Ok(bytes) => bytes,
            // Text already on screen is kept and continued, not thrown away.
            Err(_) if !turn.content.is_empty() || !turn.reasoning.is_empty() => {
                turn.finish_reason = "interrupted".into();
                return Ok(turn);
            }
            Err(error) => {
                return Err(Failure::Transport(llm::transport_error(&endpoint.name, &error)))
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(position) = buffer.find('\n') {
            let line: String = buffer.drain(..=position).collect();

            let Some(value) = parse_sse_line(&line) else {
                continue;
            };

            if let Some(error) = value.get("error") {
                if !turn.content.is_empty() || !turn.reasoning.is_empty() {
                    turn.finish_reason = "interrupted".into();
                    return Ok(turn);
                }

                let detail = error
                    .get("message")
                    .and_then(|message| message.as_str())
                    .unwrap_or("The provider reported an error mid-stream.");
                return Err(Failure::Transport(detail.to_string()));
            }

            let choice = value.get("choices").and_then(|choices| choices.get(0));

            if let Some(reason) = choice
                .and_then(|choice| choice.get("finish_reason"))
                .and_then(|reason| reason.as_str())
            {
                turn.finish_reason = reason.to_string();
            }

            let Some(delta) = choice.and_then(|choice| choice.get("delta")) else {
                continue;
            };

            for payload in apply_delta(delta, &mut turn, &mut calls) {
                let _ = app.emit("agent-delta", payload);
            }
        }
    }

    turn.tool_calls = calls.into_iter().flatten().collect();

    // A tool call cut off by the length limit is unusable; the text before it
    // is continued instead.
    if turn.finish_reason == "length" {
        turn.tool_calls.retain(|call| valid_arguments(&call.arguments));
    }

    // Some deployments ignore `stream` and answer with one JSON body; the
    // caller then retries without streaming instead of reporting an empty reply.
    if turn.content.is_empty() && turn.reasoning.is_empty() && turn.tool_calls.is_empty() {
        return Err(Failure::EmptyStream);
    }

    Ok(turn)
}

async fn send(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    body: &Value,
) -> Result<Value, Failure> {
    let response = endpoint
        .post(client, "chat/completions")
        .json(body)
        .send()
        .await
        .map_err(|error| Failure::Transport(llm::transport_error(&endpoint.name, &error)))?;

    let status = response.status().as_u16();

    if !(200..=299).contains(&status) {
        let retry_after = retry_after(&response);
        let detail = llm::read_detail(response).await;
        return Err(Failure::Http {
            status,
            message: llm::describe(&endpoint.name, status, detail.as_deref()),
            retry_after,
        });
    }

    response
        .json()
        .await
        .map_err(|error| Failure::Transport(format!("{} returned an unexpected reply: {error}", endpoint.name)))
}

async fn request_turn(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    body: &mut Value,
    app: &RunContext,
    streaming: &mut bool,
    cancel: &AtomicBool,
) -> Result<StreamedTurn, Failure> {
    if *streaming {
        match stream_turn(client, endpoint, body, app, cancel).await {
            Ok(turn) => return Ok(turn),
            // The deployment ignored `stream` and sent one JSON body instead.
            Err(Failure::EmptyStream) => {
                *streaming = false;

                if let Some(object) = body.as_object_mut() {
                    object.remove("stream");
                }
            }
            Err(other) => return Err(other),
        }
    }

    let value = send(client, endpoint, body).await?;
    let choice = value.get("choices").and_then(|choices| choices.get(0));
    let mut turn = turn_from_message(
        choice
            .and_then(|choice| choice.get("message"))
            .unwrap_or(&json!({})),
    );
    turn.finish_reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(|reason| reason.as_str())
        .unwrap_or("")
        .to_string();

    if turn.finish_reason == "length" {
        turn.tool_calls.retain(|call| valid_arguments(&call.arguments));
    }

    Ok(turn)
}

/// Failures worth trying again: the network, a timeout, rate limits and
/// server errors. A 4xx about the request itself would fail the same way.
fn retryable(failure: &Failure) -> bool {
    match failure {
        Failure::Transport(_) => true,
        Failure::Http { status, .. } => {
            matches!(status, 408 | 409 | 425 | 429 | 500 | 502 | 503 | 504 | 520..=529)
        }
        Failure::EmptyStream | Failure::Cancelled => false,
    }
}

/// The provider's `Retry-After`, in seconds (the HTTP-date form is ignored).
fn retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| seconds.ceil() as u64)
}

/// The provider is limiting or overloaded, not broken: worth waiting out.
/// Some report it mid-stream as an error event instead of a status code.
fn rate_limited(failure: &Failure) -> bool {
    match failure {
        Failure::Http { status, .. } => matches!(status, 429 | 503 | 529),
        Failure::Transport(message) => {
            let lower = message.to_lowercase();
            lower.contains("rate limit")
                || lower.contains("rate_limit")
                || lower.contains("too many requests")
                || lower.contains("overloaded")
        }
        Failure::EmptyStream | Failure::Cancelled => false,
    }
}

/// Seconds before rate-limited attempt `attempt` (1-based): what the
/// provider asked for (within reason), else a growing pause.
fn rate_limit_delay(failure: &Failure, attempt: usize) -> u64 {
    if let Failure::Http { retry_after: Some(seconds), .. } = failure {
        return (*seconds).clamp(1, 120);
    }

    RATE_LIMIT_BACKOFF[(attempt.max(1) - 1).min(RATE_LIMIT_BACKOFF.len() - 1)]
}

fn rate_limit_reason(failure: &Failure) -> &'static str {
    match failure {
        Failure::Http { status: 503 | 529, .. } => "is overloaded",
        _ => "is rate-limiting requests",
    }
}

fn spoken_duration(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

/// Sends one turn and keeps it going: a rate limit (or overload) is waited
/// out for up to `RATE_LIMIT_PATIENCE`, with one note in the timeline that
/// counts the attempts; other passing failures are retried `MAX_RETRIES`
/// times. Stop ends any wait.
#[allow(clippy::too_many_arguments)]
async fn request_patiently(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    body: &mut Value,
    app: &RunContext,
    streaming: &mut bool,
    cancel: &AtomicBool,
    next_step_id: &mut usize,
    steps: &mut Vec<AgentStep>,
) -> Result<StreamedTurn, Failure> {
    let started = std::time::Instant::now();
    let mut limited = 0usize;
    let mut other = 0usize;
    let mut note: Option<AgentStep> = None;

    let show = |step: AgentStep, steps: &mut Vec<AgentStep>| {
        let _ = app.emit("agent-step", step.clone());
        match steps.iter_mut().find(|existing| existing.id == step.id) {
            Some(existing) => *existing = step,
            None => steps.push(step),
        }
    };

    loop {
        match request_turn(client, endpoint, body, app, streaming, cancel).await {
            Ok(turn) => {
                if let Some(mut waited) = note.take() {
                    waited.status = "done".into();
                    waited.title = format!(
                        "{} was rate-limiting requests; waited {} and continued",
                        endpoint.name,
                        spoken_duration(started.elapsed())
                    );
                    waited.detail = None;
                    show(waited, steps);
                }
                return Ok(turn);
            }
            Err(failure) if rate_limited(&failure) && started.elapsed() < RATE_LIMIT_PATIENCE => {
                limited += 1;
                let wait = rate_limit_delay(&failure, limited);
                let id = match &note {
                    Some(existing) => existing.id,
                    None => {
                        let id = *next_step_id;
                        *next_step_id += 1;
                        id
                    }
                };
                let waiting = make_step(
                    id,
                    "notice",
                    format!(
                        "{} {}; trying again in {wait}s (attempt {})",
                        endpoint.name,
                        rate_limit_reason(&failure),
                        limited + 1
                    ),
                    Some("The assistant waits and carries on by itself; press Stop to give up.".into()),
                    "running",
                );
                show(waiting.clone(), steps);
                note = Some(waiting);

                if !wait_unless_cancelled(wait, cancel).await {
                    return Err(Failure::Cancelled);
                }
            }
            Err(failure) if rate_limited(&failure) => {
                if let Some(mut waited) = note.take() {
                    waited.status = "error".into();
                    waited.title = format!(
                        "{} kept rate-limiting requests for {}",
                        endpoint.name,
                        spoken_duration(started.elapsed())
                    );
                    waited.detail = None;
                    show(waited, steps);
                }
                return Err(Failure::Transport(format!(
                    "{} kept rate-limiting requests for {}, so the assistant stopped waiting. The free allowance may be used up for now: try again later, or switch provider.",
                    endpoint.name,
                    spoken_duration(started.elapsed())
                )));
            }
            Err(failure) if retryable(&failure) && other < MAX_RETRIES => {
                other += 1;
                let wait = retry_delay(&failure, other);
                let notice = make_step(
                    *next_step_id,
                    "notice",
                    format!("The request failed; retrying in {wait}s ({other} of {MAX_RETRIES})"),
                    Some(failure.message()),
                    "done",
                );
                *next_step_id += 1;
                show(notice, steps);

                if !wait_unless_cancelled(wait, cancel).await {
                    return Err(Failure::Cancelled);
                }
            }
            Err(failure) => return Err(failure),
        }
    }
}

/// Seconds to wait before retry `attempt` (1-based); rate limits wait longer.
fn retry_delay(failure: &Failure, attempt: usize) -> u64 {
    let base = match failure {
        Failure::Http { status: 429, .. } => 10,
        _ => 3,
    };
    base * attempt as u64
}

/// Sleeps for `seconds`, waking early (false) if the user presses Stop.
async fn wait_unless_cancelled(seconds: u64, cancel: &AtomicBool) -> bool {
    let until = tokio::time::Instant::now() + Duration::from_secs(seconds);

    while tokio::time::Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        tokio::time::sleep(CANCEL_POLL).await;
    }

    !cancel.load(Ordering::SeqCst)
}

fn valid_arguments(arguments: &str) -> bool {
    arguments.trim().is_empty() || serde_json::from_str::<Value>(arguments).is_ok()
}

/// What the model is told when its reply was cut off, so it picks up where
/// it stopped instead of starting over.
fn continuation_prompt(turn: &StreamedTurn) -> &'static str {
    if turn.content.trim().is_empty() {
        "You ran out of room before answering (the thinking used it all). Continue now: make the next tool call or write the answer, and keep any further thinking brief."
    } else if turn.finish_reason == "interrupted" {
        "The connection dropped while you were replying. Continue exactly where your last message stopped, without repeating what you already wrote."
    } else {
        "Your reply hit the length limit. Continue exactly where it stopped, without repeating what you already wrote. If you were about to write a large file, split it: write a first part, then add the rest with edit_file."
    }
}

fn open_objectives(objectives: &[Objective]) -> Vec<&Objective> {
    objectives.iter().filter(|o| o.status != "done").collect()
}

/// Sent when the model stops while objectives are still open.
fn objectives_nudge(objectives: &[Objective]) -> String {
    let open: Vec<String> = open_objectives(objectives)
        .iter()
        .map(|o| format!("- [{}] {}", o.status, o.title))
        .collect();

    format!(
        "Not all objectives are done yet:\n{}\n\
         Keep working: continue with the next objective now, using the tools. Do not stop to ask whether to continue or to summarise progress. \
         If everything is in fact finished, call set_objectives with all of them marked done and end with one short sentence. \
         Only if an objective cannot be done without the user's input, mark the finished ones done and ask your question.",
        open.join("\n")
    )
}

/// How many turns this run may take: the usual budget, or more while
/// objectives are open and work is still moving.
fn turn_budget(objectives: &[Objective], turns_without_progress: usize) -> usize {
    if !open_objectives(objectives).is_empty() && turns_without_progress < MAX_TURNS_WITHOUT_PROGRESS {
        MAX_STEPS_WITH_OBJECTIVES
    } else {
        MAX_STEPS
    }
}

/// Characters of conversation that fit the model's window with room for the
/// tools, the reply and a margin (≈3 characters per token, on the safe side).
fn context_budget(window_tokens: u64) -> usize {
    let usable = window_tokens.saturating_sub(REPLY_TOKENS + 3_000).max(4_000);
    (usable as usize).saturating_mul(3)
}

const COMPACTED: &str = "[Older tool output removed to keep the conversation within the model's context. Call the tool again if you need it.]";
/// Recent messages that are never compacted.
const KEEP_RECENT_MESSAGES: usize = 8;

fn message_chars(message: &Value) -> usize {
    let content = message.get("content").and_then(|c| c.as_str()).map_or(0, str::len);
    let calls = message.get("tool_calls").map_or(0, |calls| calls.to_string().len());
    content + calls
}

/// Shrinks the oldest tool results, then the arguments of old file writes,
/// until the run fits `budget` characters. The system prompt, the user's
/// messages and the latest exchanges are left alone.
fn compact_conversation(conversation: &mut [Value], budget: usize) {
    let total = |conversation: &[Value]| conversation.iter().map(message_chars).sum::<usize>();

    if total(conversation) <= budget {
        return;
    }

    let protected_from = conversation.len().saturating_sub(KEEP_RECENT_MESSAGES);

    for index in 0..protected_from {
        let message = &mut conversation[index];

        if message.get("role").and_then(|r| r.as_str()) == Some("tool")
            && message_chars(message) > COMPACTED.len() + 200
        {
            let first: String = message
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            message["content"] = json!(format!("{first}\n{COMPACTED}"));
        }

        if let Some(calls) = message.get_mut("tool_calls").and_then(|c| c.as_array_mut()) {
            for call in calls {
                let Some(arguments) = call.pointer_mut("/function/arguments") else {
                    continue;
                };
                let Some(text) = arguments.as_str() else { continue };

                if text.len() > 600 {
                    let mut short = serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({}));
                    if let Some(object) = short.as_object_mut() {
                        for key in ["content", "old_string", "new_string"] {
                            if object.contains_key(key) {
                                object.insert(key.to_string(), json!("[removed to save context]"));
                            }
                        }
                    }
                    *arguments = json!(short.to_string());
                }
            }
        }

        if total(conversation) <= budget {
            return;
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    root: Option<PathBuf>,
    app: &RunContext,
    endpoint: &Endpoint,
    model: &str,
    messages: Vec<ChatMessage>,
    auto_approve: bool,
    context_window: Option<u64>,
    approvals: &Approvals,
    cancel: &AtomicBool,
) -> Result<AgentReply, String> {
    endpoint.validate()?;
    let budget = context_budget(context_window.unwrap_or(32_768));

    if model.trim().is_empty() {
        return Err("Choose a model in Settings first.".into());
    }

    let client = llm::client()?;
    let mut conversation: Vec<Value> = Vec::new();
    let mut tools_enabled = root.is_some();
    let mut streaming = true;
    let mut next_step_id = 1usize;

    // Several system messages confuse many models (some only honour the first,
    // some reject the request), so the editor's context joins the policy.
    let others = app.overview();
    let mut system = root
        .as_deref()
        .map(|folder| policy(folder, &others))
        .unwrap_or_default();

    for message in messages.iter().filter(|message| message.role == "system") {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(&message.content);
    }

    if !system.is_empty() {
        conversation.push(json!({ "role": "system", "content": system }));
    }

    for message in messages.into_iter().filter(|message| message.role != "system") {
        conversation.push(json!({ "role": message.role, "content": message.content }));
    }

    let mut steps: Vec<AgentStep> = Vec::new();
    // The step that shows the checklist; created by the first set_objectives.
    let mut objectives_step: Option<usize> = None;
    // The current checklist, and how many tool calls ran since it last changed.
    let mut objectives: Vec<Objective> = Vec::new();
    let mut calls_since_objectives = 0usize;
    let mut prepared = tool_schema();
    // Text of a reply that was cut off and is being continued.
    let mut answer_so_far = String::new();
    // Its thinking, kept too: some models put the whole answer there.
    let mut reasoning_so_far = String::new();
    let mut continuations = 0usize;
    let mut nudges = 0usize;
    let mut turns_without_progress = 0usize;
    let mut iteration = 0usize;
    // Files read or written in this run, by content hash.
    let mut read_hashes: HashMap<String, u64> = HashMap::new();
    // The last activity entry from other sessions already passed on.
    let mut last_activity = app
        .store
        .as_ref()
        .and_then(|store| store.latest_activity_id(&app.project).ok())
        .unwrap_or(0);
    // Code changed since the last command ran, and whether a check was asked for.
    let mut unchecked_code = false;
    let mut verify_asked = false;

    if app.store.is_none() {
        if let Some(list) = prepared.as_array_mut() {
            list.retain(|tool| {
                let name = tool.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
                !SESSION_TOOLS.contains(&name)
            });
        }
    }

    while iteration < turn_budget(&objectives, turns_without_progress) {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled.message());
        }

        compact_conversation(&mut conversation, budget);
        turns_without_progress += 1;

        let mut body = json!({
            "model": model,
            "messages": conversation,
            "max_tokens": REPLY_TOKENS,
        });

        if tools_enabled {
            body["tools"] = prepared.clone();
            body["tool_choice"] = json!("auto");
        }

        if streaming {
            body["stream"] = json!(true);
        }


        let outcome = request_patiently(
            &client,
            endpoint,
            &mut body,
            app,
            &mut streaming,
            cancel,
            &mut next_step_id,
            &mut steps,
        )
        .await;
        let first_turn = iteration == 0;
        iteration += 1;

        let turn = match outcome {
            Ok(turn) => turn,
            Err(failure) if tools_enabled && first_turn && failure.tools_rejected() => {
                let reason = failure.message();
                tools_enabled = false;

                let note = make_step(
                    next_step_id,
                    "notice",
                    format!("{model} rejected the tool schema; answering without file access."),
                    Some(reason),
                    "done",
                );
                next_step_id += 1;
                let _ = app.emit("agent-step", note.clone());
                steps.push(note);

                if let Some(object) = body.as_object_mut() {
                    object.remove("tools");
                    object.remove("tool_choice");
                }

                request_patiently(
                    &client,
                    endpoint,
                    &mut body,
                    app,
                    &mut streaming,
                    cancel,
                    &mut next_step_id,
                    &mut steps,
                )
                .await
                .map_err(Failure::message)?
            }
            Err(failure) => return Err(failure.message()),
        };

        let content = turn.content.trim().to_string();

        if turn.tool_calls.is_empty() {
            // Cut off mid-reply: ask for the rest, which streams on after the
            // text already shown.
            if turn.cut_off() && continuations < MAX_CONTINUATIONS {
                continuations += 1;
                answer_so_far.push_str(&turn.content);
                reasoning_so_far.push_str(&turn.reasoning);
                conversation.push(json!({ "role": "assistant", "content": turn.content }));
                conversation.push(json!({ "role": "user", "content": continuation_prompt(&turn) }));
                continue;
            }

            // Stopped with work left: send it back to the objectives.
            if tools_enabled
                && nudges < MAX_OBJECTIVE_NUDGES
                && !open_objectives(&objectives).is_empty()
            {
                nudges += 1;
                answer_so_far.clear();
                reasoning_so_far.clear();
                conversation.push(json!({ "role": "assistant", "content": turn.content }));
                conversation.push(json!({ "role": "user", "content": objectives_nudge(&objectives) }));

                let note = make_step(
                    next_step_id,
                    "notice",
                    "Objectives still open; continuing".to_string(),
                    None,
                    "done",
                );
                next_step_id += 1;
                let _ = app.emit("agent-step", note.clone());
                steps.push(note);
                continue;
            }

            // Changed code but never ran anything: check it once before finishing.
            if tools_enabled && unchecked_code && !verify_asked {
                verify_asked = true;
                answer_so_far.clear();
                reasoning_so_far.clear();
                conversation.push(json!({ "role": "assistant", "content": turn.content }));
                conversation.push(json!({ "role": "user", "content": VERIFY_PROMPT }));

                let note = make_step(
                    next_step_id,
                    "notice",
                    "Checking the changes before finishing".to_string(),
                    None,
                    "done",
                );
                next_step_id += 1;
                let _ = app.emit("agent-step", note.clone());
                steps.push(note);
                continue;
            }

            let content = format!("{answer_so_far}{}", turn.content).trim().to_string();
            let reasoning = format!("{reasoning_so_far}{}", turn.reasoning).trim().to_string();
            let text = if content.is_empty() && !reasoning.is_empty() {
                reasoning.clone()
            } else if content.is_empty() {
                "The model returned an empty reply.".to_string()
            } else {
                content
            };

            return Ok(AgentReply {
                text,
                reasoning: (!reasoning.is_empty()).then_some(reasoning),
                steps,
                tools_enabled,
                out_of_steps: false,
            });
        }

        // Text before these calls was narration, not the answer.
        answer_so_far.clear();
        reasoning_so_far.clear();
        continuations = 0;

        let calls: Value = turn
            .tool_calls
            .iter()
            .map(|call| {
                // Providers may reject history that holds invalid JSON.
                let arguments = if valid_arguments(&call.arguments) {
                    call.arguments.clone()
                } else {
                    "{}".to_string()
                };
                json!({
                    "id": call.id.clone(),
                    "type": "function",
                    "function": { "name": call.name.clone(), "arguments": arguments }
                })
            })
            .collect();

        conversation.push(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": calls,
        }));

        for call in &turn.tool_calls {
            if !valid_arguments(&call.arguments) {
                conversation.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id.clone(),
                    "content": "The arguments of this call were cut off or were not valid JSON, so nothing was done. Send the call again; for a large file, write a first part and add the rest with edit_file.",
                }));
                continue;
            }

            let args: Value =
                serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));

            // The checklist is shown as its own card, not as a tool step.
            if call.name == "set_objectives" {
                let output = match parse_objectives(&args) {
                    Ok(list) => {
                        let id = match objectives_step {
                            Some(id) => id,
                            None => {
                                let id = next_step_id;
                                next_step_id += 1;
                                objectives_step = Some(id);
                                id
                            }
                        };
                        let report = objectives_report(&list);
                        if let Some(store) = &app.store {
                            let _ = store.set_objectives(&app.session, &json!(list));
                        }
                        turns_without_progress = 0;
                        nudges = 0;
                        objectives = list.clone();
                        calls_since_objectives = 0;
                        let step = objectives_card(id, list);
                        let _ = app.emit("agent-step", step.clone());

                        match steps.iter_mut().find(|existing| existing.id == id) {
                            Some(existing) => *existing = step,
                            None => steps.push(step),
                        }

                        report
                    }
                    Err(error) => error,
                };

                conversation.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id.clone(),
                    "content": output,
                }));
                continue;
            }
            let title = describe_call(&call.name, &args);
            let id = next_step_id;
            next_step_id += 1;

            let file = argument(&args, "path").trim();
            let mut running = make_step(id, "tool", title.clone(), None, "running");
            running.tool = Some(call.name.clone());
            running.path = (!file.is_empty()).then(|| file.to_string());
            let _ = app.emit("agent-step", running.clone());
            steps.push(running.clone());

            // Without an open folder there is no root to resolve paths against.
            let objective = objectives
                .iter()
                .find(|o| o.status == "in_progress")
                .map(|o| o.title.clone());
            let result = match root.as_deref() {
                Some(path) if is_change(&call.name) => {
                    apply_change(
                        path,
                        app,
                        &call.name,
                        &args,
                        &running,
                        auto_approve,
                        approvals,
                        cancel,
                        &mut read_hashes,
                        objective.as_deref(),
                    )
                    .await
                }
                Some(path) if call.name == "run_command" => {
                    run_command_tool(path, app, &args, &running, auto_approve, approvals, cancel)
                        .await
                }
                Some(_) if call.name == "session_status" => {
                    let overview = app.overview();
                    Ok(if overview.is_empty() {
                        "No other sessions are active on this project.".to_string()
                    } else {
                        overview
                    })
                }
                Some(_) if call.name == "message_sessions" => {
                    let message = argument(&args, "message").trim();
                    if message.is_empty() {
                        Err("message_sessions needs a message.".to_string())
                    } else {
                        app.record("note", None, &summarize(message));
                        Ok("Sent to the other sessions on this project.".to_string())
                    }
                }
                Some(path) if call.name == "read_file" => read_file(path, &args, &mut read_hashes),
                Some(path) => execute_tool(path, &call.name, &args),
                None => Err("No folder is open, so files cannot be read.".to_string()),
            };

            if cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled.message());
            }

            let rejected =
                matches!(&result, Err(error) if error == REJECTED || error == REJECTED_COMMAND);
            let (output, ok) = match result {
                Ok(text) => (truncate(text, MAX_TOOL_CONTENT), true),
                Err(error) => (error, false),
            };

            if ok && is_change(&call.name) {
                let _ = app.emit("workspace:file-changed", file.to_string());
                if is_code_file(file) {
                    unchecked_code = true;
                }
            }

            if ok && call.name == "run_command" {
                unchecked_code = false;
            }

            let mut finished = make_step(
                id,
                if ok {
                    "tool"
                } else if rejected {
                    "rejected"
                } else {
                    "error"
                },
                title,
                Some(if rejected {
                    "Rejected".to_string()
                } else if ok && call.name == "run_command" {
                    command_status(&output)
                } else {
                    summarize(&output)
                }),
                if ok { "done" } else { "error" },
            );
            finished.tool = running.tool.clone();
            finished.path = running.path.clone();
            let _ = app.emit("agent-step", finished.clone());

            if let Some(existing) = steps.iter_mut().find(|step| step.id == id) {
                *existing = finished;
            }

            if ok {
                turns_without_progress = 0;
                nudges = 0;
            }

            calls_since_objectives += 1;
            let reminder = objectives_reminder(
                &objectives,
                ok && is_change(&call.name),
                calls_since_objectives,
            );
            if reminder.is_some() {
                calls_since_objectives = 0;
            }

            let mut content = match reminder {
                Some(note) => format!("{output}\n\n{note}"),
                None => output,
            };

            // What the other sessions did meanwhile reaches this one here.
            if let Some(news) = news_from_others(app, &mut last_activity, &read_hashes) {
                let note = make_step(
                    next_step_id,
                    "notice",
                    "Update from other sessions".to_string(),
                    Some(summarize(news.lines().nth(1).unwrap_or(""))),
                    "done",
                );
                next_step_id += 1;
                let _ = app.emit("agent-step", note.clone());
                steps.push(note);
                content = format!("{content}\n\n{news}");
            }

            conversation.push(json!({
                "role": "tool",
                "tool_call_id": call.id.clone(),
                "content": content,
            }));
        }
    }

    // Every exploration turn is spent. Rather than failing, ask once more with
    // the tools taken away, so the reader gets the answer the assistant already
    // has the material for.
    conversation.push(json!({
        "role": "user",
        "content": "You have used all the steps available for tools. Answer now with what you have already read, without calling any more tools."
    }));

    let note = make_step(
        next_step_id,
        "notice",
        "Out of tool steps; answering with what was already read".to_string(),
        None,
        "done",
    );
    let _ = app.emit("agent-step", note.clone());
    steps.push(note);

    let mut final_body = json!({
        "model": model,
        "messages": conversation,
        "max_tokens": 2048,
    });

    if streaming {
        final_body["stream"] = json!(true);
    }

    let mut final_step_id = steps.iter().map(|step| step.id).max().unwrap_or(0) + 1;
    if let Ok(turn) = request_patiently(
        &client,
        endpoint,
        &mut final_body,
        app,
        &mut streaming,
        cancel,
        &mut final_step_id,
        &mut steps,
    )
    .await
    {
        let text = if turn.content.trim().is_empty() {
            turn.reasoning.trim().to_string()
        } else {
            turn.content.trim().to_string()
        };

        if !text.is_empty() {
            return Ok(AgentReply {
                text,
                reasoning: if turn.reasoning.trim().is_empty() {
                    None
                } else {
                    Some(turn.reasoning.trim().to_string())
                },
                steps,
                tools_enabled,
                out_of_steps: true,
            });
        }
    }

    let fallback = conversation
        .iter()
        .rev()
        .find(|message| {
            message
                .get("role")
                .and_then(|role| role.as_str())
                .map(|role| role == "assistant")
                .unwrap_or(false)
        })
        .and_then(|message| message.get("content").and_then(|value| value.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(AgentReply {
        text: if fallback.is_empty() {
            format!("The assistant used all {MAX_STEPS} steps without a final answer. Try a narrower request.")
        } else {
            fallback
        },
        reasoning: None,
        steps,
        tools_enabled,
        out_of_steps: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guards_whole_file_rewrites() {
        let mut read = HashMap::new();
        assert!(stale_write("new.rs", None, &read).is_none(), "new files are fine");
        assert!(stale_write("a.rs", Some("old"), &read).unwrap().contains("have not read it"));
        read.insert("a.rs".to_string(), content_hash("old"));
        assert!(stale_write("./a.rs", Some("old"), &read).is_none());
        assert!(stale_write("a.rs", Some("edited by someone"), &read).unwrap().contains("changed since you read it"));
        assert_eq!(path_key("./src\\lib.rs"), "src/lib.rs");
    }

    #[test]
    fn reads_line_ranges() {
        let text = "one\ntwo\nthree\nfour";
        assert_eq!(line_range(text, 2, Some(3)), "[Lines 2-3 of 4]\ntwo\nthree");
        assert_eq!(line_range(text, 3, None), "[Lines 3-4 of 4]\nthree\nfour");
        assert_eq!(line_range(text, 0, Some(99)), "[Lines 1-4 of 4]\none\ntwo\nthree\nfour");
        assert!(line_range(text, 9, None).contains("empty"));
    }

    #[test]
    fn tells_a_run_what_other_sessions_did() {
        let entry = |id, kind: &str, path: Option<&str>, detail: &str| store::Activity {
            id,
            session_id: "other".into(),
            session_title: "Login".into(),
            kind: kind.into(),
            path: path.map(str::to_string),
            detail: detail.into(),
            created_at: 0,
        };
        let mut read = HashMap::new();
        read.insert("src/auth.ts".to_string(), 1);

        let news = news_text(
            &[
                entry(1, "start", None, "add login"),
                entry(2, "change", Some("src/auth.ts"), "Wire up the API"),
                entry(3, "note", None, "renamed login() to signIn()"),
            ],
            &read,
            0,
        )
        .unwrap();
        assert!(news.starts_with("[Update from other sessions]"));
        assert!(news.contains("\"Login\" changed src/auth.ts (for: Wire up the API)"));
        assert!(news.contains("note from \"Login\": renamed login() to signIn()"));
        assert!(news.contains("You read src/auth.ts earlier"));
        assert!(!news.contains("started"), "start entries are not news mid-run");

        assert!(news_text(&[entry(1, "finish", None, "done")], &read, 0).is_none());
    }

    #[test]
    fn checks_code_but_not_prose() {
        assert!(is_code_file("src/main.rs"));
        assert!(is_code_file("package.json"));
        assert!(is_code_file("Makefile"));
        assert!(!is_code_file("README.md"));
        assert!(!is_code_file("docs/notes.txt"));
        assert!(!is_code_file("LICENSE"));
        assert_eq!(command_status("$ npm test\nok\n[exit code 0]"), "exit code 0");
    }

    #[test]
    fn approval_requests_carry_their_kind() {
        let wire = serde_json::to_value(ApprovalRequest {
            kind: "command".into(),
            step_id: 4,
            path: String::new(),
            before: String::new(),
            after: String::new(),
            created: false,
            command: Some("npm test".into()),
        })
        .unwrap();
        assert_eq!(wire["kind"], "command");
        assert_eq!(wire["stepId"], 4);
        assert_eq!(wire["command"], "npm test");

        let names: Vec<String> = tool_schema()
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
            .collect();
        for expected in ["run_command", "session_status", "message_sessions", "set_objectives"] {
            assert!(names.contains(&expected.to_string()), "{expected} missing");
        }
    }

    #[test]
    fn keeps_going_while_objectives_are_open() {
        let open = vec![
            Objective { title: "A".into(), status: "done".into() },
            Objective { title: "B".into(), status: "in_progress".into() },
        ];
        let done = vec![Objective { title: "A".into(), status: "done".into() }];

        assert_eq!(turn_budget(&[], 0), MAX_STEPS);
        assert_eq!(turn_budget(&done, 0), MAX_STEPS);
        assert_eq!(turn_budget(&open, 0), MAX_STEPS_WITH_OBJECTIVES);
        assert_eq!(turn_budget(&open, MAX_TURNS_WITHOUT_PROGRESS), MAX_STEPS);

        let nudge = objectives_nudge(&open);
        assert!(nudge.contains("- [in_progress] B"));
        assert!(!nudge.contains("] A"));
    }

    #[test]
    fn retries_only_failures_that_can_pass_next_time() {
        let http = |status| Failure::Http { status, message: String::new(), retry_after: None };
        assert!(retryable(&Failure::Transport("reset".into())));
        assert!(retryable(&http(429)));
        assert!(retryable(&http(503)));
        assert!(!retryable(&http(400)));
        assert!(!retryable(&http(401)));
        assert!(!retryable(&Failure::Cancelled));
        assert_eq!(retry_delay(&http(429), 2), 20);
        assert_eq!(retry_delay(&http(500), 1), 3);
    }

    #[test]
    fn waits_out_rate_limits() {
        let http = |status, retry_after| Failure::Http { status, message: String::new(), retry_after };
        assert!(rate_limited(&http(429, None)));
        assert!(rate_limited(&http(503, None)));
        assert!(rate_limited(&http(529, None)));
        assert!(!rate_limited(&http(500, None)));
        assert!(!rate_limited(&http(401, None)));
        assert!(rate_limited(&Failure::Transport("Rate limit exceeded for model".into())));
        assert!(rate_limited(&Failure::Transport("429 Too Many Requests".into())));
        assert!(!rate_limited(&Failure::Transport("connection reset".into())));
        assert!(!rate_limited(&Failure::Cancelled));

        // The provider's Retry-After wins, within reason.
        assert_eq!(rate_limit_delay(&http(429, Some(7)), 1), 7);
        assert_eq!(rate_limit_delay(&http(429, Some(0)), 1), 1);
        assert_eq!(rate_limit_delay(&http(429, Some(3600)), 1), 120);
        // Otherwise the pause grows and then holds at a minute.
        let waits: Vec<u64> = (1..=8).map(|attempt| rate_limit_delay(&http(429, None), attempt)).collect();
        assert_eq!(waits, vec![5, 10, 20, 30, 45, 60, 60, 60]);
        let total: u64 = (1..=40).map(|attempt| rate_limit_delay(&http(429, None), attempt)).sum();
        assert!(total > RATE_LIMIT_PATIENCE.as_secs(), "patience, not the attempt count, ends the wait");

        assert_eq!(rate_limit_reason(&http(503, None)), "is overloaded");
        assert_eq!(spoken_duration(Duration::from_secs(65)), "1m 05s");
        assert_eq!(spoken_duration(Duration::from_secs(9)), "9s");
    }

    #[test]
    fn continues_cut_off_replies() {
        let mut turn = StreamedTurn { finish_reason: "length".into(), ..Default::default() };
        assert!(turn.cut_off());
        assert!(continuation_prompt(&turn).contains("thinking"));
        turn.content = "Half an answ".into();
        assert!(continuation_prompt(&turn).contains("length limit"));
        turn.finish_reason = "interrupted".into();
        assert!(continuation_prompt(&turn).contains("connection dropped"));
        turn.finish_reason = "stop".into();
        assert!(!turn.cut_off());

        assert!(valid_arguments(""));
        assert!(valid_arguments("{\"path\":\"a\"}"));
        assert!(!valid_arguments("{\"path\":\"a"));
    }

    #[test]
    fn compacts_old_tool_output_to_fit_the_window() {
        let big = "line one\n".to_string() + &"x".repeat(20_000);
        let write = json!({ "path": "a.txt", "content": "y".repeat(5_000) }).to_string();
        let mut conversation = vec![json!({ "role": "system", "content": "policy" })];
        conversation.push(json!({ "role": "user", "content": "do it" }));
        conversation.push(json!({ "role": "assistant", "content": "", "tool_calls": [
            { "id": "1", "type": "function", "function": { "name": "write_file", "arguments": write } }
        ]}));
        for _ in 0..3 {
            conversation.push(json!({ "role": "tool", "tool_call_id": "1", "content": big.clone() }));
        }
        for _ in 0..KEEP_RECENT_MESSAGES {
            conversation.push(json!({ "role": "tool", "tool_call_id": "2", "content": "recent" }));
        }

        compact_conversation(&mut conversation, 10_000);

        assert_eq!(conversation[0]["content"], "policy");
        assert_eq!(conversation[1]["content"], "do it");
        let old = conversation[3]["content"].as_str().unwrap();
        assert!(old.starts_with("line one\n[Older tool output removed"));
        let arguments: Value = serde_json::from_str(
            conversation[2]["tool_calls"][0]["function"]["arguments"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(arguments["path"], "a.txt");
        assert_eq!(arguments["content"], "[removed to save context]");
        assert!(conversation.iter().rev().take(KEEP_RECENT_MESSAGES).all(|m| m["content"] == "recent"));

        let mut small = vec![json!({ "role": "tool", "content": big.clone() })];
        compact_conversation(&mut small, 1_000_000);
        assert_eq!(small[0]["content"], big.as_str());

        assert_eq!(context_budget(32_768), (32_768 - 4_096 - 3_000) * 3);
        assert_eq!(context_budget(2_000), 12_000);
    }

    #[test]
    fn reads_objectives_in_the_shapes_models_send() {
        let strict = json!({ "objectives": [
            { "title": "Read  the\nconfig", "status": "done" },
            { "title": "Add the toggle", "status": "in progress" },
            { "title": "", "status": "pending" },
            { "title": "Update docs", "status": "whatever" }
        ]});
        let parsed = parse_objectives(&strict).unwrap();
        assert_eq!(
            parsed,
            vec![
                Objective { title: "Read the config".into(), status: "done".into() },
                Objective { title: "Add the toggle".into(), status: "in_progress".into() },
                Objective { title: "Update docs".into(), status: "pending".into() },
            ]
        );

        let encoded = json!({ "objectives": "[\"One\", {\"title\": \"Two\", \"status\": \"completed\"}]" });
        let parsed = parse_objectives(&encoded).unwrap();
        assert_eq!(parsed[0].status, "pending");
        assert_eq!(parsed[1].status, "done");

        assert!(parse_objectives(&json!({})).is_err());
        assert!(parse_objectives(&json!({ "objectives": [] })).is_err());

        let many: Vec<Value> = (0..20).map(|i| json!(format!("Step {i}"))).collect();
        assert_eq!(parse_objectives(&json!({ "objectives": many })).unwrap().len(), MAX_OBJECTIVES);
        assert!(objectives_report(&parse_objectives(&strict).unwrap()).starts_with("Objectives updated (1 of 3 done)"));

        let open = parse_objectives(&strict).unwrap();
        assert!(objectives_reminder(&[], true, 9).is_none());
        assert!(objectives_reminder(&open, false, 1).is_none());
        let note = objectives_reminder(&open, true, 1).unwrap();
        assert!(note.starts_with("[Objectives: 1 of 3 done. In progress: \"Add the toggle\"."));
        assert!(objectives_reminder(&open, false, OBJECTIVES_REMINDER_AFTER).is_some());
        let all_done: Vec<Objective> = open
            .iter()
            .map(|o| Objective { title: o.title.clone(), status: "done".into() })
            .collect();
        assert!(objectives_reminder(&all_done, true, 9).is_none());

        let card = objectives_card(7, parse_objectives(&strict).unwrap());
        assert_eq!(card.kind, "objectives");
        assert_eq!(card.title, "1 of 3 objectives done");
        let wire = serde_json::to_value(&card).unwrap();
        assert_eq!(wire["objectives"][1]["status"], "in_progress");
        assert!(serde_json::to_value(make_step(1, "tool", "x".into(), None, "done")).unwrap().get("objectives").is_none());
    }

    #[test]
    fn edits_replace_exactly_one_unique_match() {
        let source = "let a = 1;\nlet b = 2;\n";
        assert_eq!(
            apply_edit(source, "let b = 2;", "let b = 3;", false).unwrap(),
            "let a = 1;\nlet b = 3;\n"
        );
        assert!(apply_edit(source, "let c", "x", false).is_err());
        assert!(apply_edit("x x", "x", "y", false).is_err());
        assert_eq!(apply_edit("x x", "x", "y", true).unwrap(), "y y");
        assert!(apply_edit(source, "", "y", false).is_err());
    }

    #[test]
    fn edits_match_lf_text_against_crlf_files() {
        let source = "one\r\ntwo\r\nthree\r\n";
        assert_eq!(
            apply_edit(source, "one\ntwo", "uno\ndos", false).unwrap(),
            "uno\r\ndos\r\nthree\r\n"
        );
    }

    #[test]
    fn counts_changed_lines_outside_the_shared_head_and_tail() {
        assert_eq!(line_stats("a\nb\nc", "a\nB\nB2\nc"), (2, 1));
        assert_eq!(line_stats("", "a\nb"), (2, 0));
        assert_eq!(line_stats("a\nb", "a\nb"), (0, 0));
    }

    #[test]
    fn parses_sse_data_lines_only() {
        assert!(parse_sse_line("data: {\"a\":1}").is_some());
        assert!(parse_sse_line("data: [DONE]").is_none());
        assert!(parse_sse_line(": keep-alive").is_none());
        assert!(parse_sse_line("event: message").is_none());
        assert!(parse_sse_line("data: not json").is_none());
    }

    #[test]
    fn assembles_streamed_text_and_tool_call_fragments() {
        let mut turn = StreamedTurn::default();
        let mut calls: Vec<Option<ToolCall>> = Vec::new();

        let first = json!({ "content": "Hel", "reasoning_content": "plan " });
        let emitted = apply_delta(&first, &mut turn, &mut calls);
        assert_eq!(emitted.len(), 2);

        apply_delta(
            &json!({
                "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "function": { "name": "read_file", "arguments": "{\"path\":" }
                }]
            }),
            &mut turn,
            &mut calls,
        );
        apply_delta(
            &json!({
                "tool_calls": [{
                    "index": 0,
                    "function": { "arguments": "\"src/main.rs\"}" }
                }]
            }),
            &mut turn,
            &mut calls,
        );

        assert_eq!(turn.content, "Hel");
        assert_eq!(turn.reasoning, "plan ");

        let assembled: Vec<ToolCall> = calls.into_iter().flatten().collect();
        assert_eq!(assembled.len(), 1);
        assert_eq!(assembled[0].name, "read_file");
        assert_eq!(assembled[0].id, "call_1");
        assert_eq!(assembled[0].arguments, "{\"path\":\"src/main.rs\"}");
    }
}
