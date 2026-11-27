//! What an agent run knows about itself and the other sessions on the same
//! project: its session id (every event it emits is tagged with it, so the UI
//! can show several runs at once), and the shared database through which runs
//! claim the files they edit, log what they change, and pass notes.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::store::{Activity, Claim, SessionSummary, Store};

/// Stop flags of the runs in progress, by session id.
pub type Runs = Mutex<HashMap<String, Arc<AtomicBool>>>;

pub struct RunContext {
    pub handle: AppHandle,
    pub session: String,
    pub title: String,
    /// The open folder, as stored with each session.
    pub project: String,
    pub store: Option<Arc<Store>>,
    pub runs: Arc<Runs>,
}

impl RunContext {
    /// Emits an event for this run. Object payloads gain a `session` field;
    /// others (a changed file's path) go out as they are.
    pub fn emit<S: Serialize>(&self, event: &str, payload: S) -> tauri::Result<()> {
        let mut value = serde_json::to_value(payload).unwrap_or(Value::Null);

        if let Value::Object(map) = &mut value {
            map.insert("session".into(), json!(self.session));
        }

        self.handle.emit(event, value)
    }

    pub fn is_running(&self, session: &str) -> bool {
        is_running(&self.runs, session)
    }

    /// Logs to the shared activity record; failures only cost the log entry.
    pub fn record(&self, kind: &str, path: Option<&str>, detail: &str) {
        if let Some(store) = &self.store {
            let _ = store.record(&self.project, &self.session, &self.title, kind, path, detail);
        }
    }
}

pub fn is_running(runs: &Runs, session: &str) -> bool {
    runs.lock().map(|runs| runs.contains_key(session)).unwrap_or(false)
}

fn ago(millis: i64, now: i64) -> String {
    let seconds = ((now - millis) / 1000).max(0);
    match seconds {
        0..=59 => "just now".into(),
        60..=3_599 => format!("{} min ago", seconds / 60),
        3_600..=86_399 => format!("{} h ago", seconds / 3_600),
        _ => format!("{} d ago", seconds / 86_400),
    }
}

/// One line per activity entry, for the model.
pub fn describe_activity(entry: &Activity, now: i64) -> String {
    let when = ago(entry.created_at, now);
    let who = &entry.session_title;
    match entry.kind.as_str() {
        "change" => {
            let path = entry.path.as_deref().unwrap_or("a file");
            if entry.detail.is_empty() {
                format!("- {when}: \"{who}\" changed {path}")
            } else {
                format!("- {when}: \"{who}\" changed {path} (for: {})", entry.detail)
            }
        }
        "note" => format!("- {when}: note from \"{who}\": {}", entry.detail),
        "start" => format!("- {when}: \"{who}\" started: {}", entry.detail),
        "finish" => format!("- {when}: \"{who}\" finished: {}", entry.detail),
        other => format!("- {when}: \"{who}\" {other}: {}", entry.detail),
    }
}

fn open_objectives(objectives: &Option<Value>) -> Vec<String> {
    objectives
        .as_ref()
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .filter(|o| o.get("status").and_then(|s| s.as_str()) != Some("done"))
                .filter_map(|o| o.get("title").and_then(|t| t.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A plain-text picture of the other sessions on this project: who is
/// running, what each is working on, which files are locked, and recent
/// changes and notes. Empty when there is nothing to tell.
pub fn overview(
    peers: &[(SessionSummary, Option<Value>)],
    running: impl Fn(&str) -> bool,
    claims: &[Claim],
    activity: &[Activity],
    own_session: &str,
    now: i64,
) -> String {
    let mut lines: Vec<String> = Vec::new();

    for (session, objectives) in peers {
        let state = if running(&session.id) { "running now" } else { "idle" };
        let mut line = format!("- \"{}\" ({state}, last active {})", session.title, ago(session.updated_at, now));
        let open = open_objectives(objectives);
        if !open.is_empty() {
            line.push_str(&format!("; open objectives: {}", open.join("; ")));
        }
        let locked: Vec<&str> = claims
            .iter()
            .filter(|claim| claim.session_id == session.id && running(&claim.session_id))
            .map(|claim| claim.path.as_str())
            .collect();
        if !locked.is_empty() {
            line.push_str(&format!("; editing (locked): {}", locked.join(", ")));
        }
        lines.push(line);
    }

    let news: Vec<String> = activity
        .iter()
        .filter(|entry| entry.session_id != own_session)
        .map(|entry| describe_activity(entry, now))
        .collect();

    if lines.is_empty() && news.is_empty() {
        return String::new();
    }

    let mut text = String::new();
    if !lines.is_empty() {
        text.push_str("Other sessions on this project:\n");
        text.push_str(&lines.join("\n"));
    }
    if !news.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str("Recent activity from other sessions:\n");
        text.push_str(&news.join("\n"));
    }
    text
}

impl RunContext {
    /// The current overview, read fresh from the database.
    pub fn overview(&self) -> String {
        let Some(store) = &self.store else {
            return String::new();
        };

        let peers = store.peers(&self.project, &self.session, 8).unwrap_or_default();
        let claims = store.claims(&self.project).unwrap_or_default();
        let activity = store
            .activity_from_others(&self.project, &self.session, 0, 15)
            .unwrap_or_default();

        overview(
            &peers,
            |id| self.is_running(id),
            &claims,
            &activity,
            &self.session,
            crate::store::now(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, title: &str, updated_at: i64) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            project: "/p".into(),
            title: title.into(),
            created_at: 0,
            updated_at,
            archived: false,
            message_count: 0,
        }
    }

    #[test]
    fn describes_other_sessions_for_the_model() {
        let now = 10 * 60_000;
        let peers = vec![
            (
                session("a", "Add login", now - 120_000),
                Some(json!([
                    { "title": "Write the form", "status": "done" },
                    { "title": "Wire up the API", "status": "in_progress" }
                ])),
            ),
            (session("b", "Docs", now - 7_200_000), None),
        ];
        let claims = vec![Claim {
            path: "src/auth.ts".into(),
            session_id: "a".into(),
            session_title: "Add login".into(),
        }];
        let activity = vec![
            Activity {
                id: 1,
                session_id: "a".into(),
                session_title: "Add login".into(),
                kind: "change".into(),
                path: Some("src/auth.ts".into()),
                detail: "Wire up the API".into(),
                created_at: now - 30_000,
            },
            Activity {
                id: 2,
                session_id: "b".into(),
                session_title: "Docs".into(),
                kind: "note".into(),
                path: None,
                detail: "README now documents login".into(),
                created_at: now - 61_000,
            },
            Activity {
                id: 3,
                session_id: "me".into(),
                session_title: "Me".into(),
                kind: "change".into(),
                path: Some("x".into()),
                detail: String::new(),
                created_at: now,
            },
        ];

        let text = overview(&peers, |id| id == "a", &claims, &activity, "me", now);

        assert!(text.contains("- \"Add login\" (running now, last active 2 min ago); open objectives: Wire up the API; editing (locked): src/auth.ts"));
        assert!(text.contains("- \"Docs\" (idle, last active 2 h ago)"));
        assert!(text.contains("just now: \"Add login\" changed src/auth.ts (for: Wire up the API)"));
        assert!(text.contains("1 min ago: note from \"Docs\": README now documents login"));
        assert!(!text.contains("\"Me\""), "a session is not told about itself");

        assert_eq!(overview(&[], |_| false, &[], &[], "me", now), "");
    }
}
