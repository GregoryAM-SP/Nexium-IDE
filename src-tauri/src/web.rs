//! Website previews: detecting web projects, running their dev server, and a
//! built-in "live server" that serves static HTML and reloads the page when a
//! file it served changes on disk.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

/// Where dev server events go: the window in the app, a recorder in tests.
pub trait Events: Clone + Send + 'static {
    fn send<T: Serialize + Clone>(&self, event: &str, payload: T);
}

impl Events for AppHandle {
    fn send<T: Serialize + Clone>(&self, event: &str, payload: T) {
        let _ = self.emit(event, payload);
    }
}

use crate::workspace::safe_join;

/// Folders never searched for pages or apps.
const SKIPPED_DIRS: [&str; 12] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".venv",
    "vendor",
];
const MAX_PAGES: usize = 200;
const MAX_LOG_LINES: usize = 400;
/// Ports the live server tries first, like the familiar editor extension.
const LIVE_PORTS: std::ops::Range<u16> = 5500..5510;

// ---------------------------------------------------------------------------
// Detection

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebApp {
    /// Folder relative to the workspace root, empty for the root itself.
    pub dir: String,
    pub name: String,
    /// "Vite", "Next.js", … or empty when nothing was recognised.
    pub framework: String,
    pub scripts: Vec<String>,
    /// The script a preview should run, e.g. `dev`.
    pub preferred: Option<String>,
    pub package_manager: String,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebInfo {
    pub detected: bool,
    pub apps: Vec<WebApp>,
    /// HTML files relative to the workspace root, the likeliest start first.
    pub pages: Vec<String>,
}

const FRAMEWORKS: [(&str, &str); 16] = [
    ("next", "Next.js"),
    ("nuxt", "Nuxt"),
    ("@remix-run/dev", "Remix"),
    ("@sveltejs/kit", "SvelteKit"),
    ("astro", "Astro"),
    ("@angular/core", "Angular"),
    ("gatsby", "Gatsby"),
    ("react-scripts", "Create React App"),
    ("@vue/cli-service", "Vue CLI"),
    ("vite", "Vite"),
    ("parcel", "Parcel"),
    ("webpack-dev-server", "webpack"),
    ("@11ty/eleventy", "Eleventy"),
    ("live-server", "live-server"),
    ("http-server", "http-server"),
    ("serve", "serve"),
];

const PREFERRED_SCRIPTS: [&str; 5] = ["dev", "start", "serve", "develop", "preview"];

fn package_manager(dir: &Path, root: &Path) -> String {
    // Workspaces keep a single lock file at the top.
    for folder in [dir, root] {
        if folder.join("pnpm-lock.yaml").is_file() {
            return "pnpm".into();
        }
        if folder.join("yarn.lock").is_file() {
            return "yarn".into();
        }
        if folder.join("bun.lockb").is_file() || folder.join("bun.lock").is_file() {
            return "bun".into();
        }
        if folder.join("package-lock.json").is_file() {
            return "npm".into();
        }
    }

    "npm".into()
}

fn read_app(root: &Path, dir: &Path) -> Option<WebApp> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;

    let scripts_map = json.get("scripts").and_then(|value| value.as_object());
    let scripts: Vec<String> = scripts_map
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();

    let has_dependency = |name: &str| {
        ["dependencies", "devDependencies"].iter().any(|field| {
            json.get(field)
                .and_then(|deps| deps.as_object())
                .is_some_and(|deps| deps.contains_key(name))
        })
    };

    let framework = FRAMEWORKS
        .iter()
        .find(|(package, _)| has_dependency(package))
        .map(|(_, label)| label.to_string())
        .unwrap_or_default();

    // A package with no runnable script and no web tooling is a library or a
    // tool config, not something to preview.
    let preferred = PREFERRED_SCRIPTS
        .iter()
        .find(|name| scripts.iter().any(|script| script == *name))
        .map(|name| name.to_string());

    if preferred.is_none() && framework.is_empty() {
        return None;
    }

    let relative = dir
        .strip_prefix(root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    Some(WebApp {
        name: json
            .get("name")
            .and_then(|name| name.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                dir.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "app".into())
            }),
        dir: relative,
        framework,
        scripts,
        preferred,
        package_manager: package_manager(dir, root),
        installed: dir.join("node_modules").is_dir() || root.join("node_modules").is_dir(),
    })
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

fn collect_pages(dir: &Path, root: &Path, depth: usize, pages: &mut Vec<String>) {
    if depth > 5 || pages.len() >= MAX_PAGES {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if path.is_dir() {
            if !skipped(&name) {
                collect_pages(&path, root, depth + 1, pages);
            }
        } else if name.ends_with(".html") || name.ends_with(".htm") {
            if let Ok(relative) = path.strip_prefix(root) {
                pages.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }

        if pages.len() >= MAX_PAGES {
            return;
        }
    }
}

fn page_rank(page: &str) -> (usize, usize, String) {
    let depth = page.matches('/').count();
    let index = if page.ends_with("index.html") { 0 } else { 1 };
    (depth, index, page.to_string())
}

pub fn detect(root: &Path) -> WebInfo {
    let mut apps: Vec<WebApp> = read_app(root, root).into_iter().collect();

    // Front ends often live one level down: `web/`, `frontend/`, `apps/site`.
    if let Ok(entries) = fs::read_dir(root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| !path.file_name().is_some_and(|name| skipped(&name.to_string_lossy())))
            .collect();
        dirs.sort();

        for dir in dirs {
            if let Some(app) = read_app(root, &dir) {
                apps.push(app);
                continue;
            }

            if let Ok(children) = fs::read_dir(&dir) {
                for child in children.flatten() {
                    let path = child.path();
                    if path.is_dir() && !skipped(&child.file_name().to_string_lossy()) {
                        apps.extend(read_app(root, &path));
                    }
                }
            }
        }
    }

    let mut pages = Vec::new();
    collect_pages(root, root, 0, &mut pages);
    pages.sort_by_key(|page| page_rank(page));

    WebInfo {
        detected: !apps.is_empty() || !pages.is_empty(),
        apps,
        pages,
    }
}

// ---------------------------------------------------------------------------
// Shared state

struct DevServer {
    child: Child,
    dir: String,
    script: String,
    url: Option<String>,
}

struct LiveServer {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct WebState {
    dev: Arc<Mutex<Option<DevServer>>>,
    logs: Arc<Mutex<VecDeque<String>>>,
    live: Mutex<Option<LiveServer>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevStatus {
    pub running: bool,
    pub dir: String,
    pub script: String,
    pub url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStatus {
    pub dev: Option<DevStatus>,
    /// The live server's origin, e.g. `http://127.0.0.1:5500`.
    pub live: Option<String>,
    pub logs: Vec<String>,
}

pub fn status(state: &WebState) -> WebStatus {
    let dev = state.dev.lock().ok().and_then(|guard| {
        guard.as_ref().map(|server| DevStatus {
            running: true,
            dir: server.dir.clone(),
            script: server.script.clone(),
            url: server.url.clone(),
        })
    });
    let live = state
        .live
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|server| live_origin(server.port)));
    let logs = state
        .logs
        .lock()
        .map(|logs| logs.iter().cloned().collect())
        .unwrap_or_default();

    WebStatus { dev, live, logs }
}

pub fn stop_all(state: &WebState) {
    stop_dev(state);
    stop_live(state);
}

// ---------------------------------------------------------------------------
// Dev servers

#[derive(Serialize, Clone)]
struct LogEvent {
    line: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    code: Option<i32>,
}

/// Removes terminal colour and cursor codes from a line of output.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }

        if ch != '\r' {
            out.push(ch);
        }
    }

    out
}

/// The first local address a dev server prints, e.g. Vite's
/// `➜  Local:   http://localhost:5173/`.
fn local_url(line: &str) -> Option<String> {
    for scheme in ["http://", "https://"] {
        let mut from = 0;

        while let Some(position) = line[from..].find(scheme) {
            let start = from + position;
            let url: String = line[start..]
                .chars()
                .take_while(|ch| !ch.is_whitespace() && !matches!(ch, '"' | '\'' | ')' | ']' | ',' | '>'))
                .collect();
            let host = &url[scheme.len()..];

            let local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]
                .iter()
                .any(|name| host.starts_with(name));

            if local {
                let url = url
                    .replace("0.0.0.0", "127.0.0.1")
                    .replace("[::]", "127.0.0.1");
                return Some(url.trim_end_matches('.').to_string());
            }

            from = start + scheme.len();
        }
    }

    None
}

fn push_log(logs: &Mutex<VecDeque<String>>, line: String) {
    if let Ok(mut logs) = logs.lock() {
        if logs.len() >= MAX_LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(line);
    }
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // npm starts node as a grandchild; only a tree kill stops the server.
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        // The server was started as its own process group.
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", child.id())])
            .status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

pub fn stop_dev(state: &WebState) {
    let running = state.dev.lock().ok().and_then(|mut guard| guard.take());

    if let Some(mut server) = running {
        kill_tree(&mut server.child);
    }
}

fn run_command(manager: &str, script: &str) -> Command {
    let args: Vec<&str> = if manager == "yarn" {
        vec![script]
    } else {
        vec!["run", script]
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // npm, pnpm and yarn are .cmd shims, which only cmd can start.
        let mut command = Command::new("cmd");
        command.arg("/C").arg(manager).args(&args);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new(manager);
        command.args(&args);
        command.process_group(0);
        command
    }
}

pub fn start_dev(
    app: &impl Events,
    state: &WebState,
    root: &Path,
    dir: &str,
    script: &str,
) -> Result<DevStatus, String> {
    let folder = safe_join(root, dir)?;
    let info = read_app(root, &folder).ok_or("That folder has no package.json with scripts.")?;

    if !info.scripts.iter().any(|name| name == script) {
        return Err(format!("package.json has no \"{script}\" script."));
    }

    stop_dev(state);

    if let Ok(mut logs) = state.logs.lock() {
        logs.clear();
    }

    let mut command = run_command(&info.package_manager, script);
    command
        .current_dir(&folder)
        // Dev servers that open a browser tab on start would leave the IDE.
        .env("BROWSER", "none")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("{} was not found. Install Node.js and make sure it is on your PATH.", info.package_manager)
        } else {
            format!("The dev server could not start: {error}")
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let launched = format!("> {} {} {}", info.package_manager, if info.package_manager == "yarn" { "" } else { "run" }, script)
        .replace("  ", " ");
    push_log(&state.logs, launched.clone());
    app.send("web:log", LogEvent { line: launched });

    {
        let mut guard = state
            .dev
            .lock()
            .map_err(|_| "The preview state is unavailable.".to_string())?;
        *guard = Some(DevServer {
            child,
            dir: dir.to_string(),
            script: script.to_string(),
            url: None,
        });
    }

    let pid = state
        .dev
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|server| server.child.id()));

    let readers: Vec<Box<dyn Read + Send>> = [
        stdout.map(|out| Box::new(out) as Box<dyn Read + Send>),
        stderr.map(|err| Box::new(err) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let remaining = Arc::new(AtomicU64::new(readers.len() as u64));

    for reader in readers {
        let app = app.clone();
        let dev = state.dev.clone();
        let logs = state.logs.clone();
        let remaining = remaining.clone();

        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let line = strip_ansi(&line);

                if let Some(url) = local_url(&line) {
                    if let Ok(mut guard) = dev.lock() {
                        if let Some(server) = guard.as_mut().filter(|server| Some(server.child.id()) == pid) {
                            if server.url.is_none() {
                                server.url = Some(url.clone());
                                app.send("web:url", url);
                            }
                        }
                    }
                }

                push_log(&logs, line.clone());
                app.send("web:log", LogEvent { line });
            }

            // The last stream to close means the process is gone.
            if remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
                let mut code = None;

                if let Ok(mut guard) = dev.lock() {
                    let ours = guard.as_ref().is_some_and(|server| Some(server.child.id()) == pid);

                    if ours {
                        if let Some(mut server) = guard.take() {
                            code = server.child.wait().ok().and_then(|status| status.code());
                        }
                    } else {
                        // Stopped by the user, or replaced by a newer server.
                        return;
                    }
                }

                let line = format!("[dev server exited{}]", code.map(|code| format!(" with code {code}")).unwrap_or_default());
                push_log(&logs, line.clone());
                app.send("web:log", LogEvent { line });
                app.send("web:exit", ExitEvent { code });
            }
        });
    }

    Ok(DevStatus {
        running: true,
        dir: dir.to_string(),
        script: script.to_string(),
        url: None,
    })
}

// ---------------------------------------------------------------------------
// Live server

const RELOAD_PATH: &str = "/__nexium/version";
const RELOAD_SCRIPT: &str = "<script>(()=>{let seen=null;const check=async()=>{try{const response=await fetch('/__nexium/version',{cache:'no-store'});const version=await response.text();if(seen!==null&&version!==seen){location.reload();return}seen=version}catch{}setTimeout(check,500)};check()})();</script>";

fn live_origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }

        out.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Puts the reload script just before `</body>`, or at the end.
fn inject_reload(html: &str) -> String {
    // ASCII lowering keeps byte offsets valid for the original string.
    match html.to_ascii_lowercase().rfind("</body>") {
        Some(position) => format!("{}{}{}", &html[..position], RELOAD_SCRIPT, &html[position..]),
        None => format!("{html}{RELOAD_SCRIPT}"),
    }
}

struct Served {
    version: AtomicU64,
    /// Files the browser has loaded, with the modification time it saw.
    watched: Mutex<HashMap<PathBuf, Option<SystemTime>>>,
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );

    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn handle(mut stream: TcpStream, root: &Path, served: &Served) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let mut head = Vec::new();
    let mut buffer = [0u8; 2048];

    while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < 16 * 1024 {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => head.extend_from_slice(&buffer[..count]),
        }
    }

    let head = String::from_utf8_lossy(&head);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        respond(&mut stream, "405 Method Not Allowed", "text/plain", b"Only GET is served.", false);
        return;
    }

    let head_only = method == "HEAD";
    let path = target.split(['?', '#']).next().unwrap_or("/");

    if path == RELOAD_PATH {
        let version = served.version.load(Ordering::SeqCst).to_string();
        respond(&mut stream, "200 OK", "text/plain", version.as_bytes(), head_only);
        return;
    }

    let decoded = percent_decode(path);
    let Ok(mut file) = safe_join(root, &decoded) else {
        respond(&mut stream, "403 Forbidden", "text/plain", b"Outside the project folder.", head_only);
        return;
    };

    if file.is_dir() {
        // Relative links on a folder's index page need the trailing slash.
        if !path.ends_with('/') {
            let location = format!("{path}/");
            let header = format!("HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(header.as_bytes());
            return;
        }
        file = file.join("index.html");
    }

    let Ok(bytes) = fs::read(&file) else {
        let body = format!("<!doctype html><title>Not found</title><body style=\"font-family:system-ui;padding:2rem;color:#555\"><h3>404 — {}</h3><p>That file is not in the project folder.</p>{RELOAD_SCRIPT}</body>", decoded.replace('<', "&lt;"));
        respond(&mut stream, "404 Not Found", "text/html; charset=utf-8", body.as_bytes(), head_only);
        return;
    };

    if let Ok(mut watched) = served.watched.lock() {
        watched.insert(file.clone(), modified(&file));
    }

    let kind = content_type(&file);

    if kind.starts_with("text/html") {
        let html = inject_reload(&String::from_utf8_lossy(&bytes));
        respond(&mut stream, "200 OK", kind, html.as_bytes(), head_only);
    } else {
        respond(&mut stream, "200 OK", kind, &bytes, head_only);
    }
}

pub fn start_live(state: &WebState, root: &Path) -> Result<String, String> {
    if let Some(origin) = state
        .live
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|server| live_origin(server.port)))
    {
        return Ok(origin);
    }

    let listener = LIVE_PORTS
        .clone()
        .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
        .or_else(|| TcpListener::bind(("127.0.0.1", 0)).ok())
        .ok_or("The live server could not open a port.")?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();

    let stop = Arc::new(AtomicBool::new(false));
    let served = Arc::new(Served {
        version: AtomicU64::new(1),
        watched: Mutex::new(HashMap::new()),
    });
    let root = root.to_path_buf();

    // Saving any file the page loaded (HTML, CSS, scripts, images) reloads it.
    {
        let stop = stop.clone();
        let served = served.clone();

        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(300));

                let mut changed = false;

                if let Ok(mut watched) = served.watched.lock() {
                    for (path, seen) in watched.iter_mut() {
                        let now = modified(path);
                        if now != *seen {
                            *seen = now;
                            changed = true;
                        }
                    }
                }

                if changed {
                    served.version.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
    }

    {
        let stop = stop.clone();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }

                let Ok(stream) = stream else { continue };
                let root = root.clone();
                let served = served.clone();

                std::thread::spawn(move || handle(stream, &root, &served));
            }
        });
    }

    if let Ok(mut guard) = state.live.lock() {
        *guard = Some(LiveServer { port, stop });
    }

    Ok(live_origin(port))
}

pub fn stop_live(state: &WebState) {
    let running = state.live.lock().ok().and_then(|mut guard| guard.take());

    if let Some(server) = running {
        server.stop.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees the flag and lets the port go.
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", server.port)) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// Opens a preview address in the system browser. Only local addresses are
/// accepted, so this cannot be used to launch arbitrary programs or sites.
pub fn open_external(url: &str) -> Result<(), String> {
    if local_url(url).as_deref() != Some(url) || url.contains(['"', '\'', ' ', '&', '|', '^', '<', '>']) {
        return Err("Only local preview addresses can be opened.".into());
    }

    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();

    result
        .map(|_| ())
        .map_err(|error| format!("The browser could not be opened: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_dev_server_urls() {
        assert_eq!(local_url("  ➜  Local:   http://localhost:5173/").as_deref(), Some("http://localhost:5173/"));
        assert_eq!(local_url("- Local:        http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(local_url("Network: http://0.0.0.0:4200/").as_deref(), Some("http://127.0.0.1:4200/"));
        assert_eq!(local_url("Docs at https://vitejs.dev/config"), None);
        assert_eq!(strip_ansi("\u{1b}[32m➜\u{1b}[39m  Local"), "➜  Local");
    }

    #[test]
    fn opens_only_local_addresses_externally() {
        for url in [
            "https://example.com/",
            "file:///C:/Windows/System32/calc.exe",
            "http://localhost:5173/\" & calc",
            "http://localhost:5173/?a=1&b=2",
            "calc.exe",
        ] {
            assert!(open_external(url).is_err(), "{url} should be refused");
        }
    }

    #[test]
    fn injects_the_reload_script() {
        let html = inject_reload("<html><BODY><p>hi</p></BODY></html>");
        assert!(html.contains("</script></BODY>"));
        assert!(inject_reload("<p>fragment</p>").ends_with("</script>"));
        assert_eq!(percent_decode("/my%20page.html"), "/my page.html");
    }

    #[test]
    fn detects_apps_and_pages() {
        let root = std::env::temp_dir().join(format!("nexium-web-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("frontend")).unwrap();
        fs::create_dir_all(root.join("site/about")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();

        fs::write(
            root.join("frontend/package.json"),
            r#"{"name":"shop-ui","scripts":{"build":"vite build","dev":"vite"},"devDependencies":{"vite":"^5"}}"#,
        )
        .unwrap();
        fs::write(root.join("frontend/pnpm-lock.yaml"), "").unwrap();
        fs::write(root.join("package.json"), r#"{"name":"tools","scripts":{"lint":"eslint ."}}"#).unwrap();
        fs::write(root.join("site/about/index.html"), "").unwrap();
        fs::write(root.join("site/index.html"), "").unwrap();
        fs::write(root.join("node_modules/pkg/index.html"), "").unwrap();

        let info = detect(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(info.detected);
        assert_eq!(info.apps.len(), 1, "a lint-only package is not a web app");
        assert_eq!(info.apps[0].dir, "frontend");
        assert_eq!(info.apps[0].framework, "Vite");
        assert_eq!(info.apps[0].preferred.as_deref(), Some("dev"));
        assert_eq!(info.apps[0].package_manager, "pnpm");
        assert_eq!(info.pages, vec!["site/index.html", "site/about/index.html"]);
    }

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<(String, String)>>>);

    impl Events for Recorder {
        fn send<T: Serialize + Clone>(&self, event: &str, payload: T) {
            let text = serde_json::to_string(&payload).unwrap_or_default();
            self.0.lock().unwrap().push((event.to_string(), text));
        }
    }

    fn port_open(port: u16) -> bool {
        TcpStream::connect(("127.0.0.1", port)).is_ok()
    }

    /// Runs a real `npm run dev` whose server starts a child process, as npm,
    /// Vite and friends do, then checks the URL is found and Stop kills both.
    #[test]
    #[ignore = "needs Node.js and npm on PATH"]
    fn runs_and_stops_a_real_dev_server() {
        let root = std::env::temp_dir().join(format!("nexium-dev-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("node_modules")).unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        fs::write(
            root.join("server.js"),
            format!(
                "const http=require('http');http.createServer((q,s)=>s.end('ok')).listen({port},()=>console.log('\x1b[32m  Local:\x1b[0m   http://localhost:{port}/'));"
            ),
        )
        .unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"name":"fake-site","scripts":{"dev":"node server.js"},"devDependencies":{"vite":"*"}}"#,
        )
        .unwrap();

        let events = Recorder::default();
        let state = WebState::default();
        start_dev(&events, &state, &root, "", "dev").unwrap();

        let mut url = None;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            url = status(&state).dev.and_then(|dev| dev.url);
            if url.is_some() {
                break;
            }
        }

        let expected = format!("http://localhost:{port}/");
        assert_eq!(url.as_deref(), Some(expected.as_str()), "logs: {:?}", status(&state).logs);
        assert!(port_open(port));
        assert!(events.0.lock().unwrap().iter().any(|(event, _)| event == "web:url"));

        stop_dev(&state);
        std::thread::sleep(Duration::from_millis(500));
        let _ = fs::remove_dir_all(&root);

        assert!(status(&state).dev.is_none());
        assert!(!port_open(port), "the node grandchild survived Stop");
        assert!(
            !events.0.lock().unwrap().iter().any(|(event, _)| event == "web:exit"),
            "a deliberate stop is not reported as a crash"
        );
    }

    #[test]
    fn serves_files_and_reloads_on_change() {
        let root = std::env::temp_dir().join(format!("nexium-live-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), "<body><h1>Hello</h1></body>").unwrap();
        fs::write(root.join("style.css"), "h1{color:red}").unwrap();

        let state = WebState::default();
        let origin = start_live(&state, &root).unwrap();
        let port: u16 = origin.rsplit(':').next().unwrap().parse().unwrap();

        let get = |path: &str| {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(stream, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };

        let page = get("/");
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.contains("<h1>Hello</h1><script>"));
        assert!(get("/style.css").contains("text/css"));
        assert!(get("/missing.png").starts_with("HTTP/1.1 404"));
        assert!(get("/../secret").starts_with("HTTP/1.1 403"));

        let before = get(RELOAD_PATH);
        std::thread::sleep(Duration::from_millis(50));
        fs::write(root.join("style.css"), "h1{color:blue}").unwrap();
        std::thread::sleep(Duration::from_millis(900));
        let after = get(RELOAD_PATH);

        stop_live(&state);
        let _ = fs::remove_dir_all(&root);

        assert_ne!(before.rsplit("\r\n\r\n").next(), after.rsplit("\r\n\r\n").next());
    }
}
