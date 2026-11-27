mod agent;
mod command;
mod git;
mod github;
mod gradle;
mod gradle_settings;
mod llm;
mod run;
mod secrets;
mod store;
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
    /// Stop flags of the assistant runs in progress, by session id.
    runs: Arc<run::Runs>,
    approvals: Arc<agent::Approvals>,
    /// The session database; None if it could not be opened (the assistant
    /// still works, without history or coordination).
    store: Mutex<Option<Arc<store::Store>>>,
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
async fn git_fetch(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::fetch(root, &github::auth_for(root))?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_pull(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::pull(root, &github::auth_for(root))?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_push(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    with_root(&state, |root| {
        git::push(root, &github::auth_for(root))?;
        git::status(root)
    })
    .await
}

// ── GitHub ──────────────────────────────────────────────────────────────────

/// The signed-in GitHub account, or None when there is no saved token and
/// the GitHub CLI is not signed in.
#[tauri::command]
async fn github_account() -> Result<Option<github::Account>, String> {
    let Some(credentials) = blocking(|| Ok(github::credentials())).await? else {
        return Ok(None);
    };
    github::account(github::API, &credentials.token, credentials.source)
        .await
        .map(Some)
}

/// Checks a token with GitHub, then saves it in the credential store.
#[tauri::command]
async fn github_sign_in(token: String) -> Result<github::Account, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Paste a GitHub token first.".into());
    }
    let account = github::account(github::API, &token, "token").await?;
    blocking(move || secrets::set_github_token(&token)).await?;
    Ok(account)
}

/// Forgets the saved token (a GitHub CLI login is left alone).
#[tauri::command]
async fn github_sign_out() -> Result<(), String> {
    blocking(secrets::remove_github_token).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishResult {
    repo: github::CreatedRepo,
    /// The current branch was pushed; false when there was nothing to push
    /// yet (no commits) or the push failed (see `push_error`).
    pushed: bool,
    push_error: Option<String>,
    status: git::GitStatus,
}

#[tauri::command]
async fn github_open(url: String) -> Result<(), String> {
    blocking(move || github::open_page(&url)).await
}

/// A name for the new repository, from the folder's name.
#[tauri::command]
fn github_suggest_name(state: State<'_, AppState>) -> String {
    let folder = project_key(&state);
    let name = std::path::Path::new(&folder)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    github::suggest_repo_name(&name)
}

/// Creates the repository on GitHub, makes it the folder's `origin`
/// (starting a git repository first if needed) and pushes the current branch.
#[tauri::command]
async fn github_publish(
    state: State<'_, AppState>,
    owner: String,
    name: String,
    description: String,
    private: bool,
) -> Result<PublishResult, String> {
    let root = current_root(&state)?;
    let name = name.trim().to_string();
    github::check_repo_name(&name)?;

    let credentials = blocking(|| Ok(github::credentials()))
        .await?
        .ok_or("Sign in to GitHub first: add a token in Settings → Source control, or run `gh auth login`.")?;

    let check = root.clone();
    blocking(move || {
        // A folder inside a larger repository gets a repository of its own;
        // only a repository rooted here can already have an origin.
        if git::is_own_repo(&check) {
            if let Some(url) = git::remote_url(&check, "origin") {
                return Err(format!("This repository already has an origin remote ({url}). Push to it instead."));
            }
        }
        Ok(())
    })
    .await?;

    let account = github::account(github::API, &credentials.token, credentials.source).await?;
    let repo = github::create_repo(
        github::API,
        &credentials.token,
        &account.login,
        owner.trim(),
        &name,
        &description,
        private,
    )
    .await?;

    let clone_url = repo.clone_url.clone();
    let token = credentials.token.clone();
    let (pushed, push_error, status) = blocking(move || {
        if !git::is_own_repo(&root) {
            git::init(&root)?;
        }
        git::add_origin(&root, &clone_url)?;

        let (pushed, push_error) = if git::has_commits(&root) {
            match git::push(&root, &github::git_env(&token)) {
                Ok(()) => (true, None),
                Err(error) => (false, Some(error)),
            }
        } else {
            (false, None)
        };

        Ok((pushed, push_error, git::status(&root)?))
    })
    .await?;

    Ok(PublishResult { repo, pushed, push_error, status })
}

#[tauri::command]
async fn git_checkout_tag(state: State<'_, AppState>, name: String) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::checkout_tag(root, &name)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_branches(state: State<'_, AppState>) -> Result<Vec<git::GitBranch>, String> {
    with_root(&state, |root| git::branches(root)).await
}

#[tauri::command]
async fn git_create_branch(
    state: State<'_, AppState>,
    name: String,
    checkout: bool,
) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::create_branch(root, &name, checkout)?;
        git::status(root)
    })
    .await
}

#[tauri::command]
async fn git_switch_branch(
    state: State<'_, AppState>,
    name: String,
    remote: bool,
) -> Result<git::GitStatus, String> {
    with_root(&state, move |root| {
        git::switch_branch(root, &name, remote)?;
        git::status(root)
    })
    .await
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
            git::push_tag(root, name.trim(), &github::auth_for(root)).map_err(|error| {
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
        git::push_tag(root, &name, &github::auth_for(root))?;
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
        git::sync(root, &github::auth_for(root))
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

/// Stops one session's run, or every run when no session is given.
#[tauri::command]
fn ai_cancel(state: State<'_, AppState>, session_id: Option<String>) {
    if let Ok(runs) = state.runs.lock() {
        for (session, flag) in runs.iter() {
            if session_id.as_deref().map_or(true, |id| id == session) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// The user's answer to a change or command a running session proposed.
#[tauri::command]
fn agent_decide(
    state: State<'_, AppState>,
    session_id: String,
    step_id: usize,
    accept: bool,
) -> Result<(), String> {
    state
        .approvals
        .lock()
        .map_err(|_| "The assistant state is unavailable.".to_string())?
        .insert((session_id, step_id), accept);
    Ok(())
}

// ── sessions ────────────────────────────────────────────────────────────────

fn session_store(state: &State<'_, AppState>) -> Result<Arc<store::Store>, String> {
    state
        .store
        .lock()
        .map_err(|_| "The session database is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "The session database could not be opened, so conversations are not saved.".to_string())
}

/// Sessions are grouped by the open folder; with none open, under "".
fn project_key(state: &State<'_, AppState>) -> String {
    state
        .root
        .lock()
        .ok()
        .and_then(|root| root.clone())
        .map(|root| root.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionListing {
    #[serde(flatten)]
    summary: store::SessionSummary,
    running: bool,
}

#[tauri::command]
async fn sessions_list(
    state: State<'_, AppState>,
    include_archived: bool,
) -> Result<Vec<SessionListing>, String> {
    let store = session_store(&state)?;
    let project = project_key(&state);
    let runs = state.runs.clone();
    blocking(move || {
        Ok(store
            .list_sessions(&project, include_archived)?
            .into_iter()
            .map(|summary| SessionListing {
                running: run::is_running(&runs, &summary.id),
                summary,
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn session_create(
    state: State<'_, AppState>,
    title: String,
) -> Result<store::SessionSummary, String> {
    let store = session_store(&state)?;
    let project = project_key(&state);
    blocking(move || store.create_session(&project, title.trim())).await
}

#[tauri::command]
async fn session_load(state: State<'_, AppState>, id: String) -> Result<store::SessionData, String> {
    let store = session_store(&state)?;
    blocking(move || store.load_session(&id)).await
}

#[tauri::command]
async fn session_save(
    state: State<'_, AppState>,
    id: String,
    messages: Vec<serde_json::Value>,
    condensed: Option<serde_json::Value>,
) -> Result<(), String> {
    let store = session_store(&state)?;
    blocking(move || store.save_messages(&id, &messages, condensed.as_ref())).await
}

#[tauri::command]
async fn session_rename(state: State<'_, AppState>, id: String, title: String) -> Result<(), String> {
    let store = session_store(&state)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Give the session a name.".into());
    }
    blocking(move || store.rename_session(&id, &title)).await
}

#[tauri::command]
async fn session_archive(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> Result<(), String> {
    if archived && run::is_running(&state.runs, &id) {
        return Err("Stop this session before archiving it.".into());
    }
    let store = session_store(&state)?;
    blocking(move || store.archive_session(&id, archived)).await
}

#[tauri::command]
async fn session_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if run::is_running(&state.runs, &id) {
        return Err("Stop this session before deleting it.".into());
    }
    let store = session_store(&state)?;
    blocking(move || store.delete_session(&id)).await
}

#[tauri::command]
async fn ai_agent(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    endpoint: llm::Endpoint,
    model: String,
    messages: Vec<llm::ChatMessage>,
    auto_approve: bool,
    context_window: Option<u64>,
    session_id: Option<String>,
) -> Result<agent::AgentReply, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_string())?
        .clone();
    let store = state.store.lock().ok().and_then(|store| store.clone());
    // A run without a saved session (no database) still gets its own id.
    let session = session_id.unwrap_or_else(store::new_id);
    let title = store
        .as_ref()
        .and_then(|store| store.session(&session).ok().flatten())
        .map(|summary| summary.title)
        .unwrap_or_else(|| "Untitled session".to_string());

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut runs = state
            .runs
            .lock()
            .map_err(|_| "The assistant state is unavailable.".to_string())?;
        if runs.contains_key(&session) {
            return Err("This session is already working. Wait for it, or stop it first.".into());
        }
        runs.insert(session.clone(), cancel.clone());
    }

    let approvals = state.approvals.clone();
    if let Ok(mut pending) = approvals.lock() {
        pending.retain(|(owner, _), _| owner != &session);
    }

    let context = run::RunContext {
        handle: app.clone(),
        session: session.clone(),
        title,
        project: root
            .as_ref()
            .map(|root| root.to_string_lossy().to_string())
            .unwrap_or_default(),
        store: store.clone(),
        runs: state.runs.clone(),
    };

    let asked = messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.lines().next().unwrap_or("").chars().take(120).collect::<String>())
        .unwrap_or_default();
    context.record("start", None, &asked);

    let result = agent::run(
        root,
        &context,
        &endpoint,
        &model,
        messages,
        auto_approve,
        context_window,
        &approvals,
        &cancel,
    )
    .await;

    // Whatever happened, the session's locks go and the others hear it ended.
    context.record(
        "finish",
        None,
        &match &result {
            Ok(reply) => reply.text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").chars().take(160).collect(),
            Err(error) => format!("stopped: {}", error.chars().take(120).collect::<String>()),
        },
    );
    if let Some(store) = &store {
        let _ = store.release_claims(&session);
    }
    if let Ok(mut runs) = state.runs.lock() {
        runs.remove(&session);
    }
    if let Ok(mut pending) = approvals.lock() {
        pending.retain(|(owner, _), _| owner != &session);
    }

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

            // The session database lives in the app data folder. Without it
            // the assistant still works; conversations are just not kept.
            match app.path().app_data_dir() {
                Ok(folder) => match store::Store::open(&folder.join("nexium.db")) {
                    Ok(opened) => {
                        if let Ok(mut slot) = app.state::<AppState>().store.lock() {
                            *slot = Some(Arc::new(opened));
                        }
                    }
                    Err(error) => eprintln!("session database unavailable: {error}"),
                },
                Err(error) => eprintln!("no app data folder for the session database: {error}"),
            }

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
            runs: Arc::new(Mutex::new(HashMap::new())),
            approvals: Arc::new(Mutex::new(HashMap::new())),
            store: Mutex::new(None),
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
            git_fetch,
            git_pull,
            git_push,
            git_branches,
            git_create_branch,
            git_switch_branch,
            git_checkout_tag,
            github_account,
            github_sign_in,
            github_sign_out,
            github_suggest_name,
            github_open,
            github_publish,
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
            ai_agent,
            sessions_list,
            session_create,
            session_load,
            session_save,
            session_rename,
            session_archive,
            session_delete
        ])
        .run(tauri::generate_context!())
        .expect("Nexium Studio failed to start");
}
