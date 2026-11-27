mod agent;
mod git;
mod gradle;
mod gradle_settings;
mod llm;
mod secrets;
mod terminal;
mod web;
mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

struct AppState {
    root: Mutex<Option<PathBuf>>,
    cancel: Arc<AtomicBool>,
    approvals: Arc<agent::Approvals>,
    terminals: Mutex<HashMap<String, terminal::Session>>,
    web: web::WebState,
}

fn current_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let guard = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?;

    guard.clone().ok_or_else(|| "Open a folder first.".to_string())
}

/// Plain (non-async) Tauri commands run on the main thread, so a slow disk walk
/// or a `git push` would freeze the whole window. Everything that touches the
/// disk or spawns git goes through here and runs on the blocking thread pool.
async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|_| "The background task stopped unexpectedly.".to_string())?
}

async fn with_root<T: Send + 'static>(
    state: &State<'_, AppState>,
    action: impl FnOnce(&PathBuf) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let root = current_root(state)?;
    blocking(move || action(&root)).await
}

#[tauri::command]
async fn open_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::WorkspaceSnapshot, String> {
    let snapshot = blocking(move || workspace::open(&PathBuf::from(&path))).await?;

    // Servers belong to the folder they were started in.
    web::stop_all(&state.web);

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
async fn create_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::WorkspaceSnapshot, String> {
    let target = path.clone();
    blocking(move || {
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("The project folder could not be created: {error}"))
    })
    .await?;

    open_workspace(state, path).await
}

#[tauri::command]
async fn read_workspace_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    with_root(&state, move |root| workspace::read(root, &path)).await
}

#[tauri::command]
async fn read_media_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::MediaFile, String> {
    with_root(&state, move |root| workspace::read_media(root, &path)).await
}

#[tauri::command]
async fn read_workspace_sources(
    state: State<'_, AppState>,
) -> Result<Vec<workspace::SourceFile>, String> {
    with_root(&state, |root| Ok(workspace::sources(root))).await
}

#[tauri::command]
async fn write_workspace_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    with_root(&state, move |root| workspace::write(root, &path, &contents)).await
}

#[tauri::command]
async fn create_workspace_entry(
    state: State<'_, AppState>,
    parent: String,
    name: String,
    kind: String,
) -> Result<String, String> {
    with_root(&state, move |root| workspace::create(root, &parent, &name, &kind)).await
}

#[tauri::command]
async fn rename_workspace_entry(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    with_root(&state, move |root| workspace::rename(root, &from, &to)).await
}

#[tauri::command]
async fn delete_workspace_entry(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_root(&state, move |root| workspace::delete(root, &path)).await
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
async fn git_identity(state: State<'_, AppState>) -> Result<git::GitIdentity, String> {
    let directory = git_working_directory(&state)?;
    blocking(move || git::identity(&directory)).await
}

#[tauri::command]
async fn git_set_identity(
    state: State<'_, AppState>,
    name: String,
    email: String,
) -> Result<git::GitIdentity, String> {
    let directory = git_working_directory(&state)?;
    blocking(move || git::set_identity(&directory, &name, &email)).await
}

#[tauri::command]
async fn git_status(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| git::status(root)).await
}

#[tauri::command]
async fn git_file_diff(
    state: State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<git::GitFileDiff, String> {
    with_root(&state, move |root| git::file_diff(root, &path, staged)).await
}

#[tauri::command]
async fn git_stage(state: State<'_, AppState>, path: String) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::stage(root, &path)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_unstage(state: State<'_, AppState>, path: String) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::unstage(root, &path)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_stage_all(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::stage_all(root)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_unstage_all(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::unstage_all(root)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_commit(state: State<'_, AppState>, message: String) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::commit(root, &message)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_tags(state: State<'_, AppState>) -> Result<Vec<git::GitTag>, String> {
    with_root(&state, |root| git::tags(root)).await
}

/// Tags the current commit and, when asked, pushes the tag to origin. A push
/// failure keeps the tag (it exists locally) and says so.
#[tauri::command]
async fn git_create_tag(
    state: State<'_, AppState>,
    name: String,
    message: String,
    push: bool,
) -> Result<Vec<git::GitTag>, String> {
    with_root(&state, move |root| {
        git::create_tag(root, &name, &message)?;

        if push {
            git::push_tag(root, name.trim()).map_err(|error| {
                format!("Created {}, but pushing it failed: {error}", name.trim())
            })?;
        }

        git::tags(root)
    })
    .await
}

#[tauri::command]
async fn git_push_tag(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<git::GitTag>, String> {
    with_root(&state, move |root| {
        git::push_tag(root, &name)?;
        git::tags(root)
    })
    .await
}

#[tauri::command]
async fn git_delete_tag(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<git::GitTag>, String> {
    with_root(&state, move |root| {
        git::delete_tag(root, &name)?;
        git::tags(root)
    })
    .await
}

#[tauri::command]
async fn git_commit_and_sync(
    state: State<'_, AppState>,
    message: String,
) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::commit(root, &message)?;
        git::sync(root)
            .map_err(|error| format!("Committed, but the sync failed: {error}"))?;
        git::status(root)
    })
    .await
}

/// Every stored provider key, keyed by provider id (missing ones are absent).
#[tauri::command]
async fn secret_get_keys(
    providers: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    blocking(move || secrets::get_keys(&providers)).await
}

/// Stores (or, with an empty key, removes) one provider's key.
#[tauri::command]
async fn secret_set_key(provider: String, key: String) -> Result<(), String> {
    blocking(move || secrets::set_key(&provider, &key)).await
}

#[tauri::command]
async fn gradle_detect(state: State<'_, AppState>) -> Result<gradle::GradleInfo, String> {
    with_root(&state, |root| Ok(gradle::detect(root))).await
}

/// Runs Gradle itself, which can take a while when the daemon is cold.
#[tauri::command]
async fn gradle_tasks(
    state: State<'_, AppState>,
    java_home: Option<String>,
) -> Result<Vec<gradle::GradleTask>, String> {
    with_root(&state, move |root| gradle::query_tasks(root, java_home.as_deref())).await
}

/// Also scans the machine for installed JDKs and Android SDKs.
#[tauri::command]
async fn gradle_settings(
    state: State<'_, AppState>,
) -> Result<gradle_settings::GradleSettings, String> {
    with_root(&state, |root| gradle_settings::read(root)).await
}

/// Writes the changed settings and tells the editor which files moved under it.
#[tauri::command]
async fn gradle_settings_apply(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    edits: Vec<gradle_settings::SettingEdit>,
) -> Result<Vec<String>, String> {
    use tauri::Emitter;

    let changed = with_root(&state, move |root| gradle_settings::apply(root, &edits)).await?;

    for file in &changed {
        let _ = app.emit("workspace:file-changed", file.clone());
    }

    Ok(changed)
}

/// How this copy was installed, so updates are only ever taken from the
/// matching installer: an MSI install must never be updated with the NSIS
/// .exe (it would install a second copy), nor a .deb with the AppImage.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallKind {
    /// The updater's platform key, e.g. `windows-x86_64`.
    target: Option<String>,
    /// `nsis`, `msi`, `appimage`, `deb`, `rpm` or `app`; None for a copy that
    /// did not come from an installer (a dev or hand-copied build).
    installer: Option<&'static str>,
}

#[tauri::command]
fn install_kind() -> InstallKind {
    use tauri::utils::config::BundleType;

    // The bundler stamps the bundle type into each installer's binary.
    let installer = match tauri::utils::platform::bundle_type() {
        Some(BundleType::Nsis) => Some("nsis"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::Deb) => Some("deb"),
        Some(BundleType::Rpm) => Some("rpm"),
        Some(BundleType::App) => Some("app"),
        _ => None,
    };

    InstallKind {
        target: tauri_plugin_updater::target(),
        installer,
    }
}

#[tauri::command]
async fn web_detect(state: State<'_, AppState>) -> Result<web::WebInfo, String> {
    with_root(&state, |root| Ok(web::detect(root))).await
}

#[tauri::command]
fn web_status(state: State<'_, AppState>) -> web::WebStatus {
    web::status(&state.web)
}

#[tauri::command]
fn web_start_dev(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dir: String,
    script: String,
    command: Option<String>,
    manager: Option<String>,
) -> Result<web::DevStatus, String> {
    let root = current_root(&state)?;
    web::start_dev(&app, &state.web, &root, &dir, &script, command.as_deref(), manager.as_deref())
}

#[tauri::command]
async fn web_stop_dev(state: State<'_, AppState>) -> Result<(), String> {
    // Async so the wait on taskkill never runs on the window's main thread.
    web::stop_dev(&state.web);
    Ok(())
}

#[tauri::command]
fn web_start_live(state: State<'_, AppState>) -> Result<String, String> {
    let root = current_root(&state)?;
    web::start_live(&state.web, &root)
}

#[tauri::command]
fn web_stop_live(state: State<'_, AppState>) {
    web::stop_live(&state.web);
}

#[tauri::command]
async fn web_open_external(url: String) -> Result<(), String> {
    blocking(move || web::open_external(&url)).await
}

#[tauri::command]
fn terminal_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    // The shell always starts in the open project, never in the app's own
    // working directory.
    let root = current_root(&state)?;

    terminal::start(&app, root, &state.terminals, id, rows, cols)
}

#[tauri::command]
fn terminal_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    terminal::write(&state.terminals, &id, &data)
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    terminal::resize(&state.terminals, &id, rows, cols)
}

#[tauri::command]
fn terminal_kill(state: State<'_, AppState>, id: String) {
    terminal::kill(&state.terminals, &id);
}

#[tauri::command]
fn ai_cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// The user's answer to a proposed file change from the running agent.
#[tauri::command]
fn agent_decide(state: State<'_, AppState>, step_id: usize, accept: bool) -> Result<(), String> {
    state
        .approvals
        .lock()
        .map_err(|_| "The assistant state is unavailable.".to_string())?
        .insert(step_id, accept);
    Ok(())
}

#[tauri::command]
async fn ai_agent(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    endpoint: llm::Endpoint,
    model: String,
    messages: Vec<llm::ChatMessage>,
    auto_approve: bool,
) -> Result<agent::AgentReply, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?
        .clone();

    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let approvals = state.approvals.clone();

    if let Ok(mut pending) = approvals.lock() {
        pending.clear();
    }

    let result = agent::run(
        root,
        &app,
        &endpoint,
        &model,
        messages,
        auto_approve,
        &approvals,
        &cancel,
    )
    .await;

    if let Err(error) = &result {
        eprintln!("ai_agent failed: {error}");
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
        // Updates come from the latest GitHub release's latest.json; the UI
        // downloads them in the background and installs them on close.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    hand_shortcuts_to_the_page(&window);
                }
            }

            #[cfg(not(windows))]
            let _ = app;

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<AppState>() {
                    terminal::kill_all(&state.terminals);
                    web::stop_all(&state.web);
                }
            }
        })
        .manage(AppState {
            root: Mutex::new(None),
            cancel: Arc::new(AtomicBool::new(false)),
            approvals: Arc::new(Mutex::new(HashMap::new())),
            terminals: Mutex::new(HashMap::new()),
            web: web::WebState::default(),
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
            git_tags,
            git_create_tag,
            git_push_tag,
            git_delete_tag,
            secret_get_keys,
            secret_set_key,
            gradle_detect,
            gradle_tasks,
            gradle_settings,
            gradle_settings_apply,
            install_kind,
            web_detect,
            web_status,
            web_start_dev,
            web_stop_dev,
            web_start_live,
            web_stop_live,
            web_open_external,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_kill,
            llm::ai_models,
            llm::ai_probe,
            llm::ai_ping,
            llm::ai_chat,
            ai_cancel,
            agent_decide,
            ai_agent
        ])
        .run(tauri::generate_context!())
        .expect("Nexium Studio failed to start");
}
