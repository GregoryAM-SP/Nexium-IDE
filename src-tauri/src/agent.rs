use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::future::{select, Either};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::nim;
use crate::nim::ChatMessage;
use crate::workspace;

const MAX_STEPS: usize = 8;
const MAX_TOOL_CONTENT: usize = 40_000;
const MAX_WRITE_CHARS: usize = 200_000;

#[derive(Serialize, Clone)]
pub struct AgentStep {
    pub id: usize,
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    pub status: String,
}

#[derive(Serialize)]
pub struct AgentReply {
    pub text: String,
    pub reasoning: Option<String>,
    pub steps: Vec<AgentStep>,
    pub tools_enabled: bool,
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
                "description": "Read a UTF-8 text file from the workspace. Always read a file before editing it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path relative to the workspace root, e.g. src/App.tsx."
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
                "description": "Write the full contents of a file in the workspace, creating it if needed. The content replaces the whole file, so include everything that should remain.",
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
        "search_text" => format!("Searching for \"{}\"", argument(args, "query")),
        other => format!("Calling {other}"),
    }
}

fn execute_tool(root: &Path, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "list_files" => workspace::list(root, argument(args, "path"), 400),
        "read_file" => workspace::read(root, argument(args, "path")),
        "write_file" => {
            let path = argument(args, "path");
            let content = argument(args, "content");

            if path.is_empty() {
                return Err("write_file needs a path.".into());
            }

            if content.chars().count() > MAX_WRITE_CHARS {
                return Err(format!(
                    "That write is too large ({MAX_WRITE_CHARS} characters maximum). Split it up."
                ));
            }

            workspace::write(root, path, content)?;
            Ok(format!("Saved {path} ({} lines).", content.lines().count()))
        }
        "search_text" => workspace::search(root, argument(args, "path"), argument(args, "query"), 120),
        other => Err(format!("Unknown tool '{other}'.")),
    }
}

fn policy(root: &Path) -> String {
    let listing = workspace::list(root, "", 200).unwrap_or_else(|_| "(unavailable)".into());

    format!(
        "You are the assistant inside Nexium Studio, a local code editor, working in the folder \"{}\".\n\
         Use the tools to inspect and change files. Never invent file contents: read a file before editing it.\n\
         Use write_file with the complete file contents when changing a file, and mention which files you touched.\n\
         When the message already contains the code to look at, answer it directly instead of exploring the folder first.\n\
         Keep answers short and concrete. If a request is ambiguous, ask one short question instead of guessing.\n\n\
         Current workspace listing:\n{}",
        root.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string()),
        truncate(listing, 6_000)
    )
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

    if let Some(thought) = delta
        .get("reasoning_content")
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
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        tool_calls: Vec::new(),
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
                arguments: function
                    .get("arguments")
                    .and_then(|value| value.as_str())
                    .unwrap_or("{}")
                    .to_string(),
            });
        }
    }

    turn
}

enum Failure {
    Transport(String),
    Http { status: u16, message: String },
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
    api_key: &str,
    body: &Value,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<StreamedTurn, Failure> {
    let response = client
        .post(format!("{}/chat/completions", nim::BASE))
        .bearer_auth(api_key)
        .header("Accept", "text/event-stream")
        .json(body)
        .send()
        .await
        .map_err(|error| Failure::Transport(nim::transport_error(&error)))?;

    let status = response.status().as_u16();

    if !(200..=299).contains(&status) {
        let detail = nim::read_detail(response).await;
        return Err(Failure::Http {
            status,
            message: nim::describe(status, detail.as_deref()),
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

        let bytes = chunk.map_err(|error| Failure::Transport(nim::transport_error(&error)))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(position) = buffer.find('\n') {
            let line: String = buffer.drain(..=position).collect();

            let Some(value) = parse_sse_line(&line) else {
                continue;
            };

            if let Some(error) = value.get("error") {
                let detail = error
                    .get("message")
                    .and_then(|message| message.as_str())
                    .unwrap_or("NVIDIA reported an error mid-stream.");
                return Err(Failure::Transport(detail.to_string()));
            }

            let Some(delta) = value
                .get("choices")
                .and_then(|choices| choices.get(0))
                .and_then(|choice| choice.get("delta"))
            else {
                continue;
            };

            for payload in apply_delta(delta, &mut turn, &mut calls) {
                let _ = app.emit("agent-delta", payload);
            }
        }
    }

    turn.tool_calls = calls.into_iter().flatten().collect();

    // Some deployments ignore `stream` and answer with one JSON body; the
    // caller then retries without streaming instead of reporting an empty reply.
    if turn.content.is_empty() && turn.reasoning.is_empty() && turn.tool_calls.is_empty() {
        return Err(Failure::EmptyStream);
    }

    Ok(turn)
}

async fn send(client: &reqwest::Client, api_key: &str, body: &Value) -> Result<Value, Failure> {
    let response = client
        .post(format!("{}/chat/completions", nim::BASE))
        .bearer_auth(api_key)
        .json(body)
        .send()
        .await
        .map_err(|error| Failure::Transport(nim::transport_error(&error)))?;

    let status = response.status().as_u16();

    if !(200..=299).contains(&status) {
        let detail = nim::read_detail(response).await;
        return Err(Failure::Http {
            status,
            message: nim::describe(status, detail.as_deref()),
        });
    }

    response
        .json()
        .await
        .map_err(|error| Failure::Transport(format!("NVIDIA returned an unexpected reply: {error}")))
}

async fn request_turn(
    client: &reqwest::Client,
    api_key: &str,
    body: &mut Value,
    app: &AppHandle,
    streaming: &mut bool,
    cancel: &AtomicBool,
) -> Result<StreamedTurn, Failure> {
    if *streaming {
        match stream_turn(client, api_key, body, app, cancel).await {
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

    let value = send(client, api_key, body).await?;
    Ok(turn_from_message(
        value
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .unwrap_or(&json!({})),
    ))
}

pub async fn run(
    root: Option<PathBuf>,
    app: &AppHandle,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    cancel: &AtomicBool,
) -> Result<AgentReply, String> {
    if api_key.trim().is_empty() {
        return Err("Connect NVIDIA NIM in Settings first.".into());
    }

    let client = nim::client()?;
    let mut conversation: Vec<Value> = Vec::new();
    let mut tools_enabled = root.is_some();
    let mut streaming = true;
    let mut next_step_id = 1usize;

    if let Some(path) = root.as_deref() {
        conversation.push(json!({ "role": "system", "content": policy(path) }));
    }

    for message in messages {
        conversation.push(json!({ "role": message.role, "content": message.content }));
    }

    let mut steps: Vec<AgentStep> = Vec::new();
    let prepared = tool_schema();

    for iteration in 0..MAX_STEPS {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled.message());
        }

        let mut body = json!({
            "model": model,
            "messages": conversation,
            "max_tokens": 4096,
        });

        if tools_enabled {
            body["tools"] = prepared.clone();
            body["tool_choice"] = json!("auto");
        }

        if streaming {
            body["stream"] = json!(true);
        }


        let turn = match request_turn(&client, api_key, &mut body, app, &mut streaming, cancel)
            .await
        {
            Ok(turn) => turn,
            Err(failure) if tools_enabled && iteration == 0 && failure.tools_rejected() => {
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

                request_turn(&client, api_key, &mut body, app, &mut streaming, cancel)
                    .await
                    .map_err(Failure::message)?
            }
            Err(failure) => return Err(failure.message()),
        };

        let content = turn.content.trim().to_string();

        if turn.tool_calls.is_empty() {
            let text = if content.is_empty() && !turn.reasoning.trim().is_empty() {
                turn.reasoning.trim().to_string()
            } else if content.is_empty() {
                "The model returned an empty reply.".to_string()
            } else {
                content
            };

            return Ok(AgentReply {
                text,
                reasoning: if turn.reasoning.trim().is_empty() {
                    None
                } else {
                    Some(turn.reasoning.trim().to_string())
                },
                steps,
                tools_enabled,
            });
        }

        let calls: Value = turn
            .tool_calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id.clone(),
                    "type": "function",
                    "function": { "name": call.name.clone(), "arguments": call.arguments.clone() }
                })
            })
            .collect();

        conversation.push(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": calls,
        }));

        for call in &turn.tool_calls {
            let args: Value =
                serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
            let title = describe_call(&call.name, &args);
            let id = next_step_id;
            next_step_id += 1;

            let running = make_step(id, "tool", title.clone(), None, "running");
            let _ = app.emit("agent-step", running.clone());
            steps.push(running);

            // Without an open folder there is no root to resolve paths against.
            let result = match root.as_deref() {
                Some(path) => execute_tool(path, &call.name, &args),
                None => Err("No folder is open, so files cannot be read.".to_string()),
            };

            let (output, ok) = match result {
                Ok(text) => (truncate(text, MAX_TOOL_CONTENT), true),
                Err(error) => (error, false),
            };

            if ok && call.name == "write_file" {
                let _ = app.emit("workspace:file-changed", argument(&args, "path").to_string());
            }

            let finished = make_step(
                id,
                if ok { "tool" } else { "error" },
                title,
                Some(summarize(&output)),
                if ok { "done" } else { "error" },
            );
            let _ = app.emit("agent-step", finished.clone());

            if let Some(existing) = steps.iter_mut().find(|step| step.id == id) {
                *existing = finished;
            }

            conversation.push(json!({
                "role": "tool",
                "tool_call_id": call.id.clone(),
                "content": output,
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

    if let Ok(turn) = request_turn(&client, api_key, &mut final_body, app, &mut streaming, cancel)
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
