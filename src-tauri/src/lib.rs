mod agent;
mod git;
mod nim;
mod workspace;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::State;

struct AppState {
    root: Mutex<Option<PathBuf>>,
    cancel: Arc<AtomicBool>,
}

fn with_root<T>(
    state: &State<'_, AppState>,
    action: impl FnOnce(&PathBuf) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?;

    match guard.as_ref() {
        Some(root) => action(root),
        None => Err("Open a folder first.".into()),
    }
}

#[tauri::command]
fn open_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::WorkspaceSnapshot, String> {
    let snapshot = workspace::open(&PathBuf::from(&path))?;

    let mut guard = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?;
    *guard = Some(PathBuf::from(&snapshot.root));

    Ok(snapshot)
}

/// Creates the folder for a new project and opens it. The path comes from a
/// save dialog, so it may sit anywhere outside the current workspace.
#[tauri::command]
fn create_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::WorkspaceSnapshot, String> {
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("The project folder could not be created: {error}"))?;

    open_workspace(state, path)
}

#[tauri::command]
fn read_workspace_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    with_root(&state, |root| workspace::read(root, &path))
}

#[tauri::command]
fn read_media_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::MediaFile, String> {
    with_root(&state, |root| workspace::read_media(root, &path))
}

#[tauri::command]
fn read_workspace_sources(
    state: State<'_, AppState>,
) -> Result<Vec<workspace::SourceFile>, String> {
    with_root(&state, |root| Ok(workspace::sources(root)))
}

#[tauri::command]
fn write_workspace_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    with_root(&state, |root| workspace::write(root, &path, &contents))
}

#[tauri::command]
fn create_workspace_entry(
    state: State<'_, AppState>,
    parent: String,
    name: String,
    kind: String,
) -> Result<String, String> {
    with_root(&state, |root| workspace::create(root, &parent, &name, &kind))
}

#[tauri::command]
fn rename_workspace_entry(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    with_root(&state, |root| workspace::rename(root, &from, &to))
}

#[tauri::command]
fn delete_workspace_entry(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_root(&state, |root| workspace::delete(root, &path))
}

/// Git identity works even before a folder is opened: the global config is not
/// tied to a repository, so the working directory is enough of an anchor.
fn git_working_directory(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let guard = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?;

    if let Some(root) = guard.as_ref() {
        return Ok(root.clone());
    }

    std::env::current_dir().map_err(|error| {
        format!("No folder is open and the working directory is unavailable: {error}")
    })
}

#[tauri::command]
fn git_identity(state: State<'_, AppState>) -> Result<git::GitIdentity, String> {
    git::identity(&git_working_directory(&state)?)
}

#[tauri::command]
fn git_set_identity(
    state: State<'_, AppState>,
    name: String,
    email: String,
) -> Result<git::GitIdentity, String> {
    git::set_identity(&git_working_directory(&state)?, &name, &email)
}

#[tauri::command]
fn git_status(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| git::status(root))
}

#[tauri::command]
fn git_file_diff(
    state: State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<git::GitFileDiff, String> {
    with_root(&state, |root| git::file_diff(root, &path, staged))
}

#[tauri::command]
fn git_stage(state: State<'_, AppState>, path: String) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::stage(root, &path)?;
        git::status(root)
    })
}

#[tauri::command]
fn git_unstage(state: State<'_, AppState>, path: String) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::unstage(root, &path)?;
        git::status(root)
    })
}

#[tauri::command]
fn git_stage_all(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::stage_all(root)?;
        git::status(root)
    })
}

#[tauri::command]
fn git_unstage_all(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::unstage_all(root)?;
        git::status(root)
    })
}

#[tauri::command]
fn git_commit(state: State<'_, AppState>, message: String) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::commit(root, &message)?;
        git::status(root)
    })
}

#[tauri::command]
fn git_commit_and_sync(
    state: State<'_, AppState>,
    message: String,
) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::commit(root, &message)?;
        git::sync(root)
            .map_err(|error| format!("Committed, but the sync failed: {error}"))?;
        git::status(root)
    })
}

#[tauri::command]
fn nim_cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn nim_agent(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    api_key: String,
    model: String,
    messages: Vec<nim::ChatMessage>,
) -> Result<agent::AgentReply, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?
        .clone();

    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();

    let result = agent::run(root, &app, api_key.trim(), &model, messages, &cancel).await;

    if let Err(error) = &result {
        eprintln!("nim_agent failed: {error}");
    }

    result
}

/// WebView2 handles the browser's shortcuts before the page ever sees them, so
/// Ctrl+F opened WebView2's find bar across the top of the window instead of
/// Monaco's find/replace widget over the file. Turning the browser accelerators
/// off hands Ctrl+F, Ctrl+H, Ctrl+P and F5 to the editor; text-editing keys
/// (Ctrl+X/C/V/A/Z, arrows, Home/End) are not part of that switch.
#[cfg(windows)]
fn hand_shortcuts_to_the_page(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };

        let Ok(settings) = core.Settings() else {
            return;
        };

        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };

        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                use tauri::Manager;

                if let Some(window) = app.get_webview_window("main") {
                    hand_shortcuts_to_the_page(&window);
                }
            }

            #[cfg(not(windows))]
            let _ = app;

            Ok(())
        })
        .manage(AppState {
            root: Mutex::new(None),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            create_workspace,
            read_workspace_file,
            read_media_file,
            read_workspace_sources,
            write_workspace_file,
            create_workspace_entry,
            rename_workspace_entry,
            delete_workspace_entry,
            git_identity,
            git_set_identity,
            git_status,
            git_file_diff,
            git_stage,
            git_unstage,
            git_stage_all,
            git_unstage_all,
            git_commit,
            git_commit_and_sync,
            nim::nim_verify,
            nim::nim_ping,
            nim::nim_chat,
            nim_cancel,
            nim_agent
        ])
        .run(tauri::generate_context!())
        .expect("Nexium Studio failed to start");
}
