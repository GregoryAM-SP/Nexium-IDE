use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// A shell running behind a pseudo-terminal. The master side stays open for as
/// long as the panel owns the session; dropping it closes the terminal.
pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Raw terminal output, base64 encoded so a read that splits a multi-byte
/// character is never decoded as two broken strings.
#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(windows)]
fn shell() -> (CommandBuilder, String) {
    let mut command = CommandBuilder::new("powershell.exe");
    // The banner would push the first prompt below the fold on every start.
    command.arg("-NoLogo");

    (command, "PowerShell".to_string())
}

#[cfg(not(windows))]
fn shell() -> (CommandBuilder, String) {
    let path = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let name = PathBuf::from(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shell".to_string());

    (CommandBuilder::new(path), name)
}

/// Starts a shell in `root` and streams its output to `terminal:data` events.
/// Returns the shell's display name for the panel header.
pub fn start(
    app: &AppHandle,
    root: PathBuf,
    sessions: &Mutex<HashMap<String, Session>>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(size(rows, cols))
        .map_err(|error| format!("The terminal could not be created: {error}"))?;

    let (mut command, shell) = shell();

    command.cwd(root);

    command.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("The shell could not start: {error}"))?;

    // The child owns the slave side now. Holding it here would keep the master
    // from ever reporting that the shell exited.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("The terminal could not be read: {error}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("The terminal could not be written to: {error}"))?;

    // A restart reuses the panel's id, so the previous shell goes first.
    kill(sessions, &id);

    sessions
        .lock()
        .map_err(|_| "The terminal state is unavailable.".to_string())?
        .insert(
            id.clone(),
            Session {
                master: pair.master,
                writer,
                child,
            },
        );

    let app = app.clone();

    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let data = BASE64.encode(&buffer[..count]);

                    if app
                        .emit(
                            "terminal:data",
                            Output {
                                id: id.clone(),
                                data,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }

        let _ = app.emit("terminal:exit", Exit { id });
    });

    Ok(shell)
}

/// Ignored when the session is already gone: a resize can arrive just after
/// the shell was closed.
pub fn resize(
    sessions: &Mutex<HashMap<String, Session>>,
    id: &str,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let guard = sessions
        .lock()
        .map_err(|_| "The terminal state is unavailable.".to_string())?;

    let Some(session) = guard.get(id) else {
        return Ok(());
    };

    session
        .master
        .resize(size(rows, cols))
        .map_err(|error| format!("The terminal could not be resized: {error}"))
}

pub fn write(
    sessions: &Mutex<HashMap<String, Session>>,
    id: &str,
    data: &str,
) -> Result<(), String> {
    let mut guard = sessions
        .lock()
        .map_err(|_| "The terminal state is unavailable.".to_string())?;

    let session = guard
        .get_mut(id)
        .ok_or_else(|| "That terminal is no longer running.".to_string())?;

    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("The terminal could not be written to: {error}"))
}

pub fn kill(sessions: &Mutex<HashMap<String, Session>>, id: &str) {
    let removed = sessions
        .lock()
        .ok()
        .and_then(|mut guard| guard.remove(id));

    if let Some(mut session) = removed {
        let _ = session.child.kill();
    }
}

/// The window is closing, so no shell should outlive it.
pub fn kill_all(sessions: &Mutex<HashMap<String, Session>>) {
    let running: Vec<Session> = sessions
        .lock()
        .map(|mut guard| guard.drain().map(|(_, session)| session).collect())
        .unwrap_or_default();

    for mut session in running {
        let _ = session.child.kill();
    }
}
