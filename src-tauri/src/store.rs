//! The app's SQLite database: assistant sessions and their messages, plus the
//! shared record that lets sessions working on the same project coordinate
//! (an activity log, notes, and claims on the files each one is editing).
//!
//! It lives in the app data folder as `nexium.db`. Sessions are grouped by the
//! project folder they were started in. Messages are stored as the UI's own
//! JSON, so the chat can change shape without a migration.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

/// Schema version, kept in `PRAGMA user_version`.
const VERSION: i64 = 1;

pub struct Store {
    connection: Mutex<Connection>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub message_count: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub session: SessionSummary,
    pub messages: Vec<Value>,
    pub condensed: Option<Value>,
}

/// One entry in a project's shared activity log.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: i64,
    pub session_id: String,
    pub session_title: String,
    /// `change` (a file was written), `note` (a message to other sessions),
    /// `start` / `finish` (a run began or ended).
    pub kind: String,
    pub path: Option<String>,
    pub detail: String,
    pub created_at: i64,
}

/// A file a session is editing; other running sessions must not edit it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub path: String,
    pub session_id: String,
    pub session_title: String,
}

/// What a session saw when it tried to claim a file.
#[derive(Debug, PartialEq)]
pub enum ClaimResult {
    Granted,
    /// Another session holds the file and is running now.
    Held(Claim),
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// A random 16-hex-digit id. RandomState is seeded from the OS per process,
/// and the clock and a counter keep ids unique within one.
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_i64(now());
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

fn database_error(error: rusqlite::Error) -> String {
    format!("The session database failed: {error}")
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)
                .map_err(|error| format!("Could not create {}: {error}", folder.display()))?;
        }

        let connection = Connection::open(path).map_err(database_error)?;
        Store::prepare(connection)
    }

    #[cfg(test)]
    pub fn in_memory() -> Store {
        Store::prepare(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn prepare(connection: Connection) -> Result<Store, String> {
        // WAL lets the UI read while an agent run writes; a busy timeout covers
        // the moment two runs write at once.
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(database_error)?;

        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;

        if version < 1 {
            connection
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS sessions (
                         id TEXT PRIMARY KEY,
                         project TEXT NOT NULL,
                         title TEXT NOT NULL,
                         created_at INTEGER NOT NULL,
                         updated_at INTEGER NOT NULL,
                         archived INTEGER NOT NULL DEFAULT 0,
                         objectives TEXT,
                         condensed TEXT
                     );
                     CREATE INDEX IF NOT EXISTS sessions_by_project
                         ON sessions (project, archived, updated_at);

                     CREATE TABLE IF NOT EXISTS messages (
                         session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
                         seq INTEGER NOT NULL,
                         body TEXT NOT NULL,
                         PRIMARY KEY (session_id, seq)
                     );

                     CREATE TABLE IF NOT EXISTS activity (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                         project TEXT NOT NULL,
                         session_id TEXT NOT NULL,
                         session_title TEXT NOT NULL,
                         kind TEXT NOT NULL,
                         path TEXT,
                         detail TEXT NOT NULL DEFAULT '',
                         created_at INTEGER NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS activity_by_project ON activity (project, id);

                     CREATE TABLE IF NOT EXISTS claims (
                         project TEXT NOT NULL,
                         path TEXT NOT NULL,
                         session_id TEXT NOT NULL,
                         claimed_at INTEGER NOT NULL,
                         PRIMARY KEY (project, path)
                     );",
                )
                .map_err(database_error)?;
            connection
                .execute_batch(&format!("PRAGMA user_version = {VERSION};"))
                .map_err(database_error)?;
        }

        // Claims only mean something while a run is going; none survive a
        // restart.
        connection
            .execute("DELETE FROM claims", [])
            .map_err(database_error)?;

        Ok(Store {
            connection: Mutex::new(connection),
        })
    }

    fn with<T>(&self, action: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "The session database is unavailable.".to_string())?;
        action(&mut connection).map_err(database_error)
    }

    // ── sessions ────────────────────────────────────────────────────────

    pub fn create_session(&self, project: &str, title: &str) -> Result<SessionSummary, String> {
        let id = new_id();
        let created = now();

        self.with(|db| {
            db.execute(
                "INSERT INTO sessions (id, project, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, project, title, created],
            )
        })?;

        self.session(&id)?.ok_or_else(|| "The new session was not saved.".to_string())
    }

    pub fn session(&self, id: &str) -> Result<Option<SessionSummary>, String> {
        self.with(|db| {
            db.query_row(
                "SELECT s.id, s.project, s.title, s.created_at, s.updated_at, s.archived,
                        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id)
                 FROM sessions s WHERE s.id = ?1",
                params![id],
                summary_from_row,
            )
            .optional()
        })
    }

    pub fn list_sessions(&self, project: &str, include_archived: bool) -> Result<Vec<SessionSummary>, String> {
        self.with(|db| {
            let mut statement = db.prepare(
                "SELECT s.id, s.project, s.title, s.created_at, s.updated_at, s.archived,
                        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id)
                 FROM sessions s
                 WHERE s.project = ?1 AND (?2 OR s.archived = 0)
                 ORDER BY s.updated_at DESC",
            )?;
            let rows = statement.query_map(params![project, include_archived], summary_from_row)?;
            rows.collect()
        })
    }

    pub fn load_session(&self, id: &str) -> Result<SessionData, String> {
        let session = self.session(id)?.ok_or_else(|| "That session no longer exists.".to_string())?;

        let (messages, condensed) = self.with(|db| {
            let mut statement =
                db.prepare("SELECT body FROM messages WHERE session_id = ?1 ORDER BY seq")?;
            let messages = statement
                .query_map(params![id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            let condensed: Option<String> = db.query_row(
                "SELECT condensed FROM sessions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )?;
            Ok((messages, condensed))
        })?;

        Ok(SessionData {
            session,
            messages: messages
                .iter()
                .filter_map(|body| serde_json::from_str(body).ok())
                .collect(),
            condensed: condensed.and_then(|text| serde_json::from_str(&text).ok()),
        })
    }

    /// Replaces the session's messages (a retry can cut the conversation, so
    /// the whole list is the truth) in one transaction.
    pub fn save_messages(
        &self,
        id: &str,
        messages: &[Value],
        condensed: Option<&Value>,
    ) -> Result<(), String> {
        self.with(|db| {
            let transaction = db.transaction()?;
            let updated = transaction.execute(
                "UPDATE sessions SET updated_at = ?2, condensed = ?3 WHERE id = ?1",
                params![id, now(), condensed.map(|value| value.to_string())],
            )?;

            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            transaction.execute("DELETE FROM messages WHERE session_id = ?1", params![id])?;
            {
                let mut insert = transaction
                    .prepare("INSERT INTO messages (session_id, seq, body) VALUES (?1, ?2, ?3)")?;
                for (seq, message) in messages.iter().enumerate() {
                    insert.execute(params![id, seq as i64, message.to_string()])?;
                }
            }
            transaction.commit()
        })
    }

    pub fn rename_session(&self, id: &str, title: &str) -> Result<(), String> {
        self.with(|db| db.execute("UPDATE sessions SET title = ?2 WHERE id = ?1", params![id, title]))
            .map(|_| ())
    }

    pub fn archive_session(&self, id: &str, archived: bool) -> Result<(), String> {
        self.with(|db| {
            db.execute(
                "UPDATE sessions SET archived = ?2 WHERE id = ?1",
                params![id, archived],
            )
        })
        .map(|_| ())
    }

    /// Removes the session, its messages, its claims and its activity.
    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        self.with(|db| {
            let transaction = db.transaction()?;
            transaction.execute("DELETE FROM claims WHERE session_id = ?1", params![id])?;
            transaction.execute("DELETE FROM activity WHERE session_id = ?1", params![id])?;
            transaction.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
            transaction.commit()
        })
    }

    /// The session's current objectives, as the agent's JSON list.
    pub fn set_objectives(&self, id: &str, objectives: &Value) -> Result<(), String> {
        self.with(|db| {
            db.execute(
                "UPDATE sessions SET objectives = ?2 WHERE id = ?1",
                params![id, objectives.to_string()],
            )
        })
        .map(|_| ())
    }

    /// Other sessions of the project, most recent first, with their objectives.
    pub fn peers(&self, project: &str, except: &str, limit: usize) -> Result<Vec<(SessionSummary, Option<Value>)>, String> {
        self.with(|db| {
            let mut statement = db.prepare(
                "SELECT s.id, s.project, s.title, s.created_at, s.updated_at, s.archived,
                        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id), s.objectives
                 FROM sessions s
                 WHERE s.project = ?1 AND s.id <> ?2 AND s.archived = 0
                 ORDER BY s.updated_at DESC LIMIT ?3",
            )?;
            let rows = statement.query_map(params![project, except, limit as i64], |row| {
                let objectives: Option<String> = row.get(7)?;
                Ok((
                    summary_from_row(row)?,
                    objectives.and_then(|text| serde_json::from_str(&text).ok()),
                ))
            })?;
            rows.collect()
        })
    }

    // ── activity ────────────────────────────────────────────────────────

    pub fn record(
        &self,
        project: &str,
        session_id: &str,
        session_title: &str,
        kind: &str,
        path: Option<&str>,
        detail: &str,
    ) -> Result<i64, String> {
        self.with(|db| {
            db.execute(
                "INSERT INTO activity (project, session_id, session_title, kind, path, detail, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![project, session_id, session_title, kind, path, detail, now()],
            )?;
            Ok(db.last_insert_rowid())
        })
    }

    pub fn latest_activity_id(&self, project: &str) -> Result<i64, String> {
        self.with(|db| {
            db.query_row(
                "SELECT COALESCE(MAX(id), 0) FROM activity WHERE project = ?1",
                params![project],
                |row| row.get(0),
            )
        })
    }

    /// Activity by other sessions: newer than `after_id`, or the latest
    /// `limit` entries when `after_id` is 0. Oldest first.
    pub fn activity_from_others(
        &self,
        project: &str,
        except: &str,
        after_id: i64,
        limit: usize,
    ) -> Result<Vec<Activity>, String> {
        self.with(|db| {
            let mut statement = db.prepare(
                "SELECT id, session_id, session_title, kind, path, detail, created_at FROM (
                     SELECT * FROM activity
                     WHERE project = ?1 AND session_id <> ?2 AND id > ?3
                     ORDER BY id DESC LIMIT ?4
                 ) ORDER BY id",
            )?;
            let rows = statement.query_map(params![project, except, after_id, limit as i64], |row| {
                Ok(Activity {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    session_title: row.get(2)?,
                    kind: row.get(3)?,
                    path: row.get(4)?,
                    detail: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?;
            rows.collect()
        })
    }

    // ── claims ──────────────────────────────────────────────────────────

    /// Claims `path` for `session_id`. A claim held by a session that is not
    /// running (`is_running` says false) is stale and taken over.
    pub fn claim(
        &self,
        project: &str,
        path: &str,
        session_id: &str,
        is_running: impl Fn(&str) -> bool,
    ) -> Result<ClaimResult, String> {
        self.with(|db| {
            let holder: Option<(String, String)> = db
                .query_row(
                    "SELECT c.session_id, COALESCE(s.title, 'another session')
                     FROM claims c LEFT JOIN sessions s ON s.id = c.session_id
                     WHERE c.project = ?1 AND c.path = ?2",
                    params![project, path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;

            if let Some((holder, title)) = holder {
                if holder != session_id && is_running(&holder) {
                    return Ok(ClaimResult::Held(Claim {
                        path: path.to_string(),
                        session_id: holder,
                        session_title: title,
                    }));
                }
            }

            db.execute(
                "INSERT INTO claims (project, path, session_id, claimed_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (project, path) DO UPDATE SET session_id = ?3, claimed_at = ?4",
                params![project, path, session_id, now()],
            )?;
            Ok(ClaimResult::Granted)
        })
    }

    pub fn release_claims(&self, session_id: &str) -> Result<(), String> {
        self.with(|db| db.execute("DELETE FROM claims WHERE session_id = ?1", params![session_id]))
            .map(|_| ())
    }

    pub fn claims(&self, project: &str) -> Result<Vec<Claim>, String> {
        self.with(|db| {
            let mut statement = db.prepare(
                "SELECT c.path, c.session_id, COALESCE(s.title, 'another session')
                 FROM claims c LEFT JOIN sessions s ON s.id = c.session_id
                 WHERE c.project = ?1 ORDER BY c.path",
            )?;
            let rows = statement.query_map(params![project], |row| {
                Ok(Claim {
                    path: row.get(0)?,
                    session_id: row.get(1)?,
                    session_title: row.get(2)?,
                })
            })?;
            rows.collect()
        })
    }
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        id: row.get(0)?,
        project: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        archived: row.get::<_, i64>(5)? != 0,
        message_count: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_sessions_and_messages_per_project() {
        let store = Store::in_memory();
        let a = store.create_session("/p", "First").unwrap();
        let b = store.create_session("/p", "Second").unwrap();
        store.create_session("/other", "Elsewhere").unwrap();
        assert_ne!(a.id, b.id);

        let messages = vec![json!({ "id": 1, "role": "user", "text": "hi" }), json!({ "id": 2, "role": "assistant", "text": "hello" })];
        let condensed = json!({ "summary": "s", "throughId": 1, "saved": 10 });
        store.save_messages(&a.id, &messages, Some(&condensed)).unwrap();

        let loaded = store.load_session(&a.id).unwrap();
        assert_eq!(loaded.messages, messages);
        assert_eq!(loaded.condensed, Some(condensed));
        assert_eq!(loaded.session.message_count, 2);

        // A retry that cut the conversation replaces it.
        store.save_messages(&a.id, &messages[..1], None).unwrap();
        let loaded = store.load_session(&a.id).unwrap();
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.condensed, None);

        let listed = store.list_sessions("/p", false).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, a.id, "the last saved session comes first");

        store.rename_session(&b.id, "Renamed").unwrap();
        store.archive_session(&b.id, true).unwrap();
        assert_eq!(store.list_sessions("/p", false).unwrap().len(), 1);
        let all = store.list_sessions("/p", true).unwrap();
        assert!(all.iter().any(|s| s.title == "Renamed" && s.archived));

        assert!(store.save_messages("missing", &messages, None).is_err());
    }

    #[test]
    fn deleting_removes_messages_claims_and_activity() {
        let store = Store::in_memory();
        let a = store.create_session("/p", "A").unwrap();
        store.save_messages(&a.id, &[json!({ "id": 1 })], None).unwrap();
        store.record("/p", &a.id, "A", "change", Some("x.rs"), "").unwrap();
        store.claim("/p", "x.rs", &a.id, |_| true).unwrap();

        store.delete_session(&a.id).unwrap();

        assert!(store.session(&a.id).unwrap().is_none());
        assert!(store.load_session(&a.id).is_err());
        assert!(store.claims("/p").unwrap().is_empty());
        assert!(store.activity_from_others("/p", "nobody", 0, 10).unwrap().is_empty());
        let leftover: i64 = store.with(|db| db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))).unwrap();
        assert_eq!(leftover, 0);
    }

    #[test]
    fn claims_block_other_running_sessions_only() {
        let store = Store::in_memory();
        let a = store.create_session("/p", "Login").unwrap();
        let b = store.create_session("/p", "Refactor").unwrap();

        assert_eq!(store.claim("/p", "src/auth.ts", &a.id, |_| true).unwrap(), ClaimResult::Granted);
        // The holder claiming again is fine.
        assert_eq!(store.claim("/p", "src/auth.ts", &a.id, |_| true).unwrap(), ClaimResult::Granted);

        match store.claim("/p", "src/auth.ts", &b.id, |_| true).unwrap() {
            ClaimResult::Held(claim) => {
                assert_eq!(claim.session_id, a.id);
                assert_eq!(claim.session_title, "Login");
            }
            other => panic!("expected the file to be held, got {other:?}"),
        }

        // A stale claim (holder not running) is taken over.
        assert_eq!(store.claim("/p", "src/auth.ts", &b.id, |id| id != a.id).unwrap(), ClaimResult::Granted);
        assert_eq!(store.claims("/p").unwrap()[0].session_id, b.id);

        store.release_claims(&b.id).unwrap();
        assert!(store.claims("/p").unwrap().is_empty());
    }

    #[test]
    fn reports_activity_from_other_sessions() {
        let store = Store::in_memory();
        let a = store.create_session("/p", "A").unwrap();
        let b = store.create_session("/p", "B").unwrap();
        let start = store.latest_activity_id("/p").unwrap();

        store.record("/p", &a.id, "A", "change", Some("one.rs"), "Add login").unwrap();
        store.record("/p", &b.id, "B", "note", None, "I'm renaming utils.rs").unwrap();
        store.record("/other", &a.id, "A", "change", Some("zzz.rs"), "").unwrap();

        let for_a = store.activity_from_others("/p", &a.id, start, 10).unwrap();
        assert_eq!(for_a.len(), 1);
        assert_eq!(for_a[0].kind, "note");
        assert_eq!(for_a[0].detail, "I'm renaming utils.rs");

        let latest = store.latest_activity_id("/p").unwrap();
        assert!(store.activity_from_others("/p", &a.id, latest, 10).unwrap().is_empty());

        store.set_objectives(&a.id, &json!([{ "title": "Add login", "status": "in_progress" }])).unwrap();
        let peers = store.peers("/p", &b.id, 5).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].1.as_ref().unwrap()[0]["title"], "Add login");
    }

    #[test]
    fn persists_on_disk_and_drops_claims_on_reopen() {
        let dir = std::env::temp_dir().join(format!("nexium-store-{}", new_id()));
        let path = dir.join("nexium.db");
        {
            let store = Store::open(&path).unwrap();
            let s = store.create_session("/p", "Kept").unwrap();
            store.save_messages(&s.id, &[json!({ "id": 1, "text": "remember me" })], None).unwrap();
            store.claim("/p", "a.rs", &s.id, |_| true).unwrap();
        }
        let store = Store::open(&path).unwrap();
        let sessions = store.list_sessions("/p", false).unwrap();
        assert_eq!(sessions[0].title, "Kept");
        assert_eq!(store.load_session(&sessions[0].id).unwrap().messages[0]["text"], "remember me");
        assert!(store.claims("/p").unwrap().is_empty());
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_are_unique() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 1000);
    }
}
