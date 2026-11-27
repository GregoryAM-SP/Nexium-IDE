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
    /// Every script in package.json.
    pub scripts: Vec<String>,
    /// The scripts that start a server, the likeliest first.
    pub servers: Vec<ServerScript>,
    /// The script a preview should run, e.g. `dev`.
    pub preferred: Option<String>,
    /// A command to offer when no script starts a server, e.g. `npx vite`.
    pub fallback: Option<String>,
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

/// A package.json script that starts a server the preview can show.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerScript {
    pub name: String,
    pub command: String,
    /// The port it is expected to listen on, from its flags, the tool's
    /// config file or the tool's default.
    pub port: Option<u16>,
}

/// Script names (or parts of `a:b` names) that never start the site: builds,
/// checks, packaging, and desktop or mobile shells that open their own window.
const NOT_SERVER_NAMES: [&str; 22] = [
    "build", "test", "lint", "format", "fmt", "typecheck", "type-check", "check", "clean",
    "deploy", "release", "publish", "tauri", "electron", "desktop", "android", "ios", "mobile",
    "e2e", "storybook", "prepare", "postinstall",
];

/// Tools that wrap the site in a native window: never the preview's job.
const WRAPPER_COMMANDS: [&str; 5] = ["tauri", "electron", "electron-vite", "cap", "cargo"];

/// Builds and checks. Blanked out before looking for a server, so
/// `vite build && vite preview` still counts as a (production) server.
const BUILD_COMMANDS: [&str; 14] = [
    "vite build", "next build", "next lint", "astro build", "astro check", "nuxt build",
    "nuxi build", "nuxt generate", "nuxi generate", "ng build", "gatsby build",
    "react-scripts build", "vue-cli-service build", "parcel build",
];

/// Commands that start a dev or preview server, and the port each listens on
/// when nothing says otherwise. Longer phrases come before their prefixes.
const SERVER_COMMANDS: [(&str, u16); 24] = [
    ("vite preview", 4173),
    ("next dev", 3000),
    ("next start", 3000),
    ("next", 3000),
    ("astro dev", 4321),
    ("astro preview", 4321),
    ("nuxt dev", 3000),
    ("nuxi dev", 3000),
    ("remix dev", 3000),
    ("remix vite:dev", 5173),
    ("vite dev", 5173),
    ("vite serve", 5173),
    ("vite", 5173),
    ("webpack serve", 8080),
    ("webpack-dev-server", 8080),
    ("react-scripts start", 3000),
    ("vue-cli-service serve", 8080),
    ("ng serve", 4200),
    ("gatsby develop", 8000),
    ("parcel", 1234),
    ("eleventy --serve", 8080),
    ("live-server", 8080),
    ("http-server", 8080),
    ("serve", 3000),
];

/// Servers that need a build first: offered, but after the dev server.
const PRODUCTION_SERVERS: [&str; 3] = ["vite preview", "next start", "astro preview"];

fn word_boundary(ch: Option<char>) -> bool {
    ch.map_or(true, |ch| {
        ch.is_whitespace() || matches!(ch, '"' | '\'' | '&' | '|' | ';' | '(' | ')' | '/' | '=')
    })
}

/// Where `needle` appears in `command` as whole words.
fn find_words(command: &str, needle: &str) -> Option<usize> {
    let mut from = 0;

    while let Some(position) = command[from..].find(needle) {
        let start = from + position;
        let end = start + needle.len();

        if word_boundary(command[..start].chars().next_back()) && word_boundary(command[end..].chars().next()) {
            return Some(start);
        }
        from = end;
    }

    None
}

fn has_words(command: &str, needle: &str) -> bool {
    find_words(command, needle).is_some()
}

/// The command with its build steps blanked out.
fn without_builds(command: &str) -> String {
    let mut command = command.to_ascii_lowercase();

    for build in BUILD_COMMANDS {
        while let Some(start) = find_words(&command, build) {
            command.replace_range(start..start + build.len(), &" ".repeat(build.len()));
        }
    }

    command
}

/// The server tool a command runs, with its default port.
fn server_tool(command: &str) -> Option<(&'static str, u16)> {
    let command = without_builds(command);

    SERVER_COMMANDS
        .iter()
        .find(|(tool, _)| has_words(&command, tool))
        .map(|(tool, port)| (*tool, *port))
}

/// A port given on the command line: `--port 3001`, `--port=3001`, `-p 3001`.
fn port_flag(command: &str) -> Option<u16> {
    let words: Vec<&str> = command.split_whitespace().collect();

    for (index, word) in words.iter().enumerate() {
        if let Some(value) = word.strip_prefix("--port=") {
            return value.trim_matches(['"', '\'']).parse().ok();
        }
        if matches!(*word, "--port" | "-p") {
            return words.get(index + 1)?.trim_matches(['"', '\'']).parse().ok();
        }
    }

    None
}

/// `server.port` from a Vite config. A plain text search: it is only a hint,
/// and the address the server prints always wins.
fn vite_config_port(dir: &Path) -> Option<u16> {
    let text = ["ts", "mts", "js", "mjs", "cjs"]
        .iter()
        .find_map(|ext| fs::read_to_string(dir.join(format!("vite.config.{ext}"))).ok())?;
    let server = &text[text.find("server:").or_else(|| text.find("server ="))?..];

    // The first `port: <number>`, skipping comments that mention a port.
    server.match_indices("port").find_map(|(start, _)| {
        let before = server[..start].chars().next_back();
        if before.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return None;
        }
        let after = server[start + 4..].trim_start().strip_prefix(':')?.trim_start();
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    })
}

/// The port a server command is expected to listen on.
fn expected_port(dir: &Path, command: &str) -> Option<u16> {
    port_flag(command).or_else(|| match server_tool(command)? {
        ("vite" | "vite dev" | "vite serve" | "remix vite:dev", port) => vite_config_port(dir).or(Some(port)),
        (_, port) => Some(port),
    })
}

/// How likely a script is the one to preview, lower first, or `None` when it
/// does not start a server.
fn server_rank(name: &str, command: &str) -> Option<u8> {
    let name = name.to_ascii_lowercase();
    let lower = command.to_ascii_lowercase();
    let mut parts = name.split([':', '-', '_']);
    let base = parts.next().unwrap_or_default();

    if NOT_SERVER_NAMES.contains(&base) || parts.any(|part| NOT_SERVER_NAMES.contains(&part)) {
        return None;
    }
    if WRAPPER_COMMANDS.iter().any(|tool| has_words(&lower, tool)) {
        return None;
    }

    let tool = server_tool(&lower).map(|(tool, _)| tool);
    let builds_first = PRODUCTION_SERVERS.iter().any(|server| tool == Some(*server))
        || BUILD_COMMANDS.iter().any(|build| has_words(&lower, build));
    let dev_name = matches!(base, "dev" | "develop" | "start" | "serve" | "server" | "preview" | "watch");

    if tool.is_none() {
        // A builder or checker on its own is not a server; a script called
        // `dev` or `start` that runs something unknown (a Node app) may be.
        let checker = ["tsc", "eslint", "prettier", "vitest", "jest", "playwright", "biome"]
            .iter()
            .any(|tool| has_words(&lower, tool));
        if builds_first || checker || !dev_name || base == "watch" || base == "preview" {
            return None;
        }
    }

    let rank = match (name.as_str(), builds_first) {
        ("dev" | "develop", false) => 0,
        ("start", false) => 1,
        ("serve" | "server", false) => 2,
        (_, false) if dev_name => 3,
        (_, false) => 4,
        ("preview" | "start" | "serve", true) => 6,
        (_, true) => 7,
    };

    Some(rank)
}

/// The scripts that start a server, the likeliest first.
fn server_scripts(dir: &Path, scripts: &serde_json::Map<String, serde_json::Value>) -> Vec<ServerScript> {
    let mut ranked: Vec<(u8, usize, ServerScript)> = scripts
        .iter()
        .enumerate()
        .filter_map(|(order, (name, command))| {
            let command = command.as_str().unwrap_or_default().to_string();
            let rank = server_rank(name, &command)?;
            let port = expected_port(dir, &command);

            Some((rank, order, ServerScript { name: name.clone(), command, port }))
        })
        .collect();

    ranked.sort_by_key(|(rank, order, _)| (*rank, *order));
    ranked.into_iter().map(|(_, _, script)| script).collect()
}

/// The manager a `packageManager` field names, e.g. `pnpm@9.1.0`.
fn declared_manager(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let field = json.get("packageManager")?.as_str()?;
    let name = field.split('@').next()?.trim();

    ["npm", "pnpm", "yarn", "bun"]
        .contains(&name)
        .then(|| name.to_string())
}

/// Where a package manager's program lives: a PATH folder, or the folder its
/// own installer uses, which an app started from the desktop may not have on
/// its PATH.
fn locate_manager(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"].iter().map(|ext| format!("{name}.{ext}")).collect()
    } else {
        vec![name.to_string()]
    };

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if let Some(home) = &home {
        dirs.push(home.join(".bun").join("bin"));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("pnpm"));
        }
        if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
            dirs.push(roaming.join("npm"));
        }
    } else if let Some(home) = &home {
        dirs.push(home.join(".local/share/pnpm"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }

    dirs.into_iter()
        .find(|dir| names.iter().any(|file| dir.join(file).is_file()))
}

/// The manager to run scripts with: the project's own, or npm when that one
/// is not installed (npm runs any package.json script, whoever installed the
/// dependencies).
fn usable_manager(wanted: String) -> String {
    if wanted != "npm" && locate_manager(&wanted).is_none() && locate_manager("npm").is_some() {
        "npm".into()
    } else {
        wanted
    }
}

/// The package manager the project uses, from `packageManager` or its lock file.
fn package_manager(dir: &Path, root: &Path) -> String {
    const LOCKS: [(&str, &str); 6] = [
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
        ("npm-shrinkwrap.json", "npm"),
    ];

    // The app's own folder first; workspaces keep a single lock file at the top.
    for folder in [dir, root] {
        if let Some(manager) = declared_manager(folder) {
            return manager;
        }
        if let Some((_, manager)) = LOCKS.iter().find(|(lock, _)| folder.join(lock).is_file()) {
            return manager.to_string();
        }
    }

    "npm".into()
}

/// The command to offer when package.json has no script that starts the
/// server, e.g. `npx vite` in a project that only lists the dependency.
fn fallback_command(framework: &str, manager: &str) -> Option<String> {
    let tool = match framework {
        "Vite" | "SvelteKit" => "vite",
        "Next.js" => "next dev",
        "Astro" => "astro dev",
        "Nuxt" => "nuxt dev",
        "Gatsby" => "gatsby develop",
        "Angular" => "ng serve",
        "Parcel" => "parcel index.html",
        "Create React App" => "react-scripts start",
        "Vue CLI" => "vue-cli-service serve",
        "Eleventy" => "eleventy --serve",
        "webpack" => "webpack serve",
        "live-server" => "live-server",
        "http-server" => "http-server",
        "serve" => "serve",
        _ => return None,
    };
    let exec = match manager {
        "bun" => "bunx",
        "pnpm" => "pnpm exec",
        "yarn" => "yarn",
        _ => "npx",
    };

    Some(format!("{exec} {tool}"))
}

fn read_app(root: &Path, dir: &Path) -> Option<WebApp> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;

    let empty = serde_json::Map::new();
    let scripts_map = json.get("scripts").and_then(|value| value.as_object()).unwrap_or(&empty);
    let scripts: Vec<String> = scripts_map.keys().cloned().collect();

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

    let servers = server_scripts(dir, scripts_map);

    // A package with no server script and no web tooling is a library, a
    // tool config or a CLI, not something to preview.
    if servers.is_empty() && framework.is_empty() {
        return None;
    }

    let relative = dir
        .strip_prefix(root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let manager = usable_manager(package_manager(dir, root));

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
        fallback: if servers.is_empty() { fallback_command(&framework, &manager) } else { None },
        framework,
        scripts,
        preferred: servers.first().map(|script| script.name.clone()),
        servers,
        package_manager: manager,
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
    expects_preview: bool,
    /// A web page that refuses to be shown in a frame.
    blocked_url: Option<String>,
    /// Addresses already being checked, so each is checked once.
    offered: Vec<String>,
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
    /// The command is known to start a web server. False for a custom
    /// command that runs something else, which may never have a preview.
    pub expects_preview: bool,
    /// The server's page, which does not allow being shown in a frame.
    pub blocked_url: Option<String>,
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
            expects_preview: server.expects_preview,
            blocked_url: server.blocked_url.clone(),
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

/// `bun run dev --port 5174`, as it is shown in the log.
fn script_line(manager: &str, script: &str, extra: &[String]) -> String {
    script_args(manager, script, extra)
        .iter()
        .fold(manager.to_string(), |line, arg| format!("{line} {arg}"))
}

/// The arguments that run a package.json script, passing `extra` on to it.
fn script_args(manager: &str, script: &str, extra: &[String]) -> Vec<String> {
    let mut args: Vec<String> = match manager {
        "yarn" => vec![script.to_string()],
        _ => vec!["run".into(), script.to_string()],
    };

    if !extra.is_empty() {
        // npm keeps flags before `--` for itself; the others pass them on.
        if manager == "npm" {
            args.push("--".into());
        }
        args.extend(extra.iter().cloned());
    }

    args
}

enum Launch<'a> {
    Script { manager: &'a str, script: &'a str, extra: Vec<String> },
    Shell(&'a str),
}

fn launch_command(launch: &Launch) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // npm, pnpm and yarn are .cmd shims, which only cmd can start.
        let mut command = Command::new("cmd");
        command.arg("/C");
        match launch {
            Launch::Script { manager, script, extra } => {
                command.arg(manager).args(script_args(manager, script, extra));
            }
            // Typed by the user for their shell: handed over untouched.
            Launch::Shell(line) => {
                command.raw_arg(line);
            }
        }
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;

        let mut command = match launch {
            Launch::Script { manager, script, extra } => {
                let mut command = Command::new(manager);
                command.args(script_args(manager, script, extra));
                command
            }
            Launch::Shell(line) => {
                let mut command = Command::new("sh");
                command.arg("-c").arg(line);
                command
            }
        };
        command.process_group(0);
        command
    }
}

/// Something already listens on the port, on either loopback address.
fn port_taken(port: u16) -> bool {
    let timeout = Duration::from_millis(250);
    let v4 = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let v6 = std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port));

    TcpStream::connect_timeout(&v4, timeout).is_ok()
        || TcpStream::connect_timeout(&v6, timeout).is_ok()
        || TcpListener::bind(v4).is_err()
}

/// The nearest free port above `port`, or any the OS hands out.
fn free_port_after(port: u16) -> Option<u16> {
    (port.saturating_add(1)..port.saturating_add(50))
        .find(|candidate| !port_taken(*candidate))
        .or_else(|| {
            TcpListener::bind(("127.0.0.1", 0))
                .ok()
                .and_then(|listener| listener.local_addr().ok())
                .map(|address| address.port())
        })
}

/// The flags that move a server tool to another port. Empty for tools that
/// only read the `PORT` variable, which is always set too.
fn port_args(tool: Option<&str>, port: u16) -> Vec<String> {
    match tool {
        None | Some("react-scripts start") => Vec::new(),
        Some("serve") => vec!["-l".into(), port.to_string()],
        Some("live-server") => vec![format!("--port={port}")],
        Some("http-server") => vec!["-p".into(), port.to_string()],
        Some(_) => vec!["--port".into(), port.to_string()],
    }
}

/// The address to show once the expected port answers but the server has
/// not printed one: 127.0.0.1 when it listens there, otherwise localhost.
fn port_url(port: u16) -> Option<String> {
    let timeout = Duration::from_millis(250);

    if TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), timeout).is_ok() {
        Some(format!("http://127.0.0.1:{port}/"))
    } else if TcpStream::connect_timeout(&std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)), timeout).is_ok() {
        Some(format!("http://localhost:{port}/"))
    } else {
        None
    }
}

fn log(app: &impl Events, logs: &Mutex<VecDeque<String>>, line: String) {
    push_log(logs, line.clone());
    app.send("web:log", LogEvent { line });
}

/// The message for a package manager that is not installed, naming npm as
/// the way that always works.
fn missing_manager(name: &str, script: Option<&str>) -> String {
    let instead = match script {
        Some(script) if name != "npm" => format!(" Choose \"npm run {script}\" instead, or install {name}."),
        _ if name != "npm" => format!(" Use npm instead, or install {name}."),
        _ => " Install Node.js, which includes npm, and restart Nexium Studio.".into(),
    };
    format!("{name} is not installed, or not on your PATH.{instead}")
}

/// Starts a package.json `script` in `dir` with the project's package manager
/// (or `manager`, when the user picked one), or the user's own `command` line
/// when one is given, and follows its output for the address to preview.
pub fn start_dev(
    app: &impl Events,
    state: &WebState,
    root: &Path,
    dir: &str,
    script: &str,
    command: Option<&str>,
    manager_choice: Option<&str>,
) -> Result<DevStatus, String> {
    let folder = safe_join(root, dir)?;
    let custom = command.map(str::trim).filter(|line| !line.is_empty());

    if let Some(choice) = manager_choice {
        if !["npm", "pnpm", "yarn", "bun"].contains(&choice) {
            return Err(format!("{choice} is not a package manager."));
        }
    }

    if !folder.is_dir() {
        return Err("That folder no longer exists.".into());
    }

    let manager;
    let mut port;
    let tool;
    let label;
    let expects_preview;

    if let Some(line) = custom {
        // A line that starts with a package manager names one to check for.
        let program = line.split_whitespace().next().unwrap_or_default();
        let owner = match program {
            "npx" => Some("npm"),
            "bunx" => Some("bun"),
            "npm" | "pnpm" | "yarn" | "bun" => Some(program),
            _ => None,
        };
        if let Some(owner) = owner.filter(|owner| locate_manager(owner).is_none()) {
            return Err(missing_manager(owner, None));
        }
        manager = String::new();
        port = expected_port(&folder, line);
        tool = None;
        label = line.to_string();
        expects_preview = port.is_some();
    } else {
        let info = read_app(root, &folder).ok_or("That folder has no package.json with a dev server script.")?;
        let source = fs::read_to_string(folder.join("package.json")).unwrap_or_default();
        let json: serde_json::Value = serde_json::from_str(&source).unwrap_or_default();
        let script_command = json
            .get("scripts")
            .and_then(|scripts| scripts.get(script))
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("package.json has no \"{script}\" script."))?
            .to_string();

        manager = manager_choice.map(str::to_string).unwrap_or(info.package_manager);
        if locate_manager(&manager).is_none() {
            return Err(missing_manager(&manager, Some(script)));
        }
        port = expected_port(&folder, &script_command);
        tool = server_tool(&script_command).map(|(tool, _)| tool);
        label = script.to_string();
        expects_preview = true;

        // A port fixed on the command line is the user's choice to keep.
        if port_flag(&script_command).is_some() {
            if let Some(fixed) = port.filter(|fixed| port_taken(*fixed)) {
                return Err(format!(
                    "Port {fixed} is already in use, and the \"{script}\" script asks for it with --port. Stop what is using it, or run a custom command with another port."
                ));
            }
        }
    }

    stop_dev(state);

    if let Ok(mut logs) = state.logs.lock() {
        logs.clear();
    }

    // Servers such as Vite with `strictPort` stop at once when their port is
    // taken (often by the same app running in a terminal), so move them.
    let mut extra = Vec::new();
    let mut note = None;

    if custom.is_none() {
        if let Some(wanted) = port.filter(|wanted| port_taken(*wanted)) {
            if let Some(free) = free_port_after(wanted) {
                extra = port_args(tool, free);
                note = Some(format!("[port {wanted} is in use, so the server starts on {free}]"));
                port = Some(free);
            } else {
                port = None;
            }
        }
    } else if port.is_some_and(port_taken) {
        // Without knowing the tool, the port the line names cannot be moved;
        // the printed address is all there is to go on.
        port = None;
    }

    let launch = match custom {
        Some(line) => Launch::Shell(line),
        None => Launch::Script { manager: &manager, script, extra: extra.clone() },
    };

    let mut process = launch_command(&launch);
    process
        .current_dir(&folder)
        // Dev servers that open a browser tab on start would leave the IDE.
        .env("BROWSER", "none")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if custom.is_none() {
        if let Some(port) = port {
            process.env("PORT", port.to_string());
        }

        // A manager found in its installer's folder rather than on PATH.
        if let Some(found) = locate_manager(&manager) {
            let mut paths = vec![found];
            if let Some(path) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&path));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                process.env("PATH", joined);
            }
        }
    }

    let mut child = process.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            let program = if manager.is_empty() { "The shell" } else { manager.as_str() };
            format!("{program} was not found. Install it and make sure it is on your PATH.")
        } else {
            format!("The dev server could not start: {error}")
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(note) = note {
        log(app, &state.logs, note);
    }
    let launched = match custom {
        Some(line) => format!("> {line}"),
        None => format!("> {}", script_line(&manager, script, &extra)),
    };
    log(app, &state.logs, launched);

    {
        let mut guard = state
            .dev
            .lock()
            .map_err(|_| "The preview state is unavailable.".to_string())?;
        *guard = Some(DevServer {
            child,
            dir: dir.to_string(),
            script: label.clone(),
            url: None,
            expects_preview,
            blocked_url: None,
            offered: Vec::new(),
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

                // The shell's own words for a missing program are easy to miss.
                if line.contains("is not recognized as an internal or external command") || line.ends_with(": command not found") || line.ends_with(": not found") {
                    log(&app, &logs, line);
                    log(&app, &logs, "[a program this command runs is not installed or not on your PATH]".into());
                    continue;
                }

                if let Some(url) = local_url(&line) {
                    offer_url(&app, &dev, &logs, pid, url);
                }

                log(&app, &logs, line);
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

                log(&app, &logs, format!("[dev server exited{}]", code.map(|code| format!(" with code {code}")).unwrap_or_default()));
                app.send("web:exit", ExitEvent { code });
            }
        });
    }

    // Some servers print no address (or print it in a way not recognised):
    // once the expected port answers, show it anyway.
    if let Some(port) = port {
        let app = app.clone();
        let dev = state.dev.clone();
        let logs = state.logs.clone();

        std::thread::spawn(move || {
            let waiting = || {
                dev.lock().ok().is_some_and(|guard| {
                    guard
                        .as_ref()
                        .is_some_and(|server| Some(server.child.id()) == pid && server.url.is_none())
                })
            };

            for _ in 0..360 {
                std::thread::sleep(Duration::from_millis(500));
                if !waiting() {
                    return;
                }
                if port_url(port).is_some() {
                    // Give the server a moment to print its own address.
                    std::thread::sleep(Duration::from_millis(1500));
                    if let Some(url) = port_url(port).filter(|_| waiting()) {
                        offer_url(&app, &dev, &logs, pid, url);
                    }
                    return;
                }
            }
        });
    }

    Ok(DevStatus {
        running: true,
        dir: dir.to_string(),
        script: label,
        url: None,
        expects_preview,
        blocked_url: None,
    })
}

/// What a local address answered with.
#[derive(Debug, PartialEq)]
enum Probe {
    /// An HTML page (or a redirect to one) the preview can show.
    Page,
    /// A page that forbids frames, which would show as a blank preview.
    Unframeable,
    /// Something else: an API, a websocket endpoint, an error status.
    NotPage(String),
    /// Nothing listens yet, or it did not answer in time.
    NoAnswer,
}

/// Loads `url` the way the preview frame would and says whether a web page
/// came back. Plain HTTP only; an https address is taken on trust.
fn probe(url: &str) -> Probe {
    let Some(rest) = url.strip_prefix("http://") else {
        return Probe::Page;
    };
    let (host, path) = match rest.find('/') {
        Some(slash) => (&rest[..slash], &rest[slash..]),
        None => (rest, "/"),
    };
    let port: u16 = host
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse().ok())
        .unwrap_or(80);
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    let addresses: Vec<std::net::SocketAddr> = match name {
        "127.0.0.1" => vec![std::net::SocketAddr::from(([127, 0, 0, 1], port))],
        "[::1]" => vec![std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port))],
        // `localhost` may be served on either loopback address.
        _ => vec![
            std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        ],
    };
    let timeout = Duration::from_millis(800);
    let Some(mut stream) = addresses
        .iter()
        .find_map(|address| TcpStream::connect_timeout(address, timeout).ok())
    else {
        return Probe::NoAnswer;
    };

    // The first request to a framework dev server may compile the page first.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: text/html,*/*\r\nUser-Agent: Nexium-Studio-Preview\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Probe::NoAnswer;
    }

    let mut head = Vec::new();
    let mut buffer = [0u8; 4096];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < 32 * 1024 {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => head.extend_from_slice(&buffer[..count]),
        }
    }
    let _ = stream.shutdown(Shutdown::Both);

    page_kind(&String::from_utf8_lossy(&head))
}

/// Reads an HTTP response head: is it a page a frame can show?
fn page_kind(head: &str) -> Probe {
    let mut lines = head.split("\r\n");
    let Some(status) = lines
        .next()
        .filter(|line| line.starts_with("HTTP/"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
    else {
        return if head.is_empty() {
            Probe::NoAnswer
        } else {
            Probe::NotPage("an answer that is not HTTP".into())
        };
    };

    let headers: Vec<(String, String)> = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_ascii_lowercase()))
        .collect();
    let header = |name: &str| headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());

    let redirect = (300..400).contains(&status) && header("location").is_some();
    let html = header("content-type").is_some_and(|kind| kind.contains("html"));

    if !redirect && !((200..300).contains(&status) && html) {
        let what = match header("content-type") {
            Some(kind) => format!("status {status} ({})", kind.split(';').next().unwrap_or(kind)),
            None => format!("status {status}"),
        };
        return Probe::NotPage(what);
    }

    let frame_option = header("x-frame-options")
        .is_some_and(|value| value.contains("deny") || value.contains("sameorigin"));
    let frame_policy = header("content-security-policy").is_some_and(|policy| {
        policy
            .split(';')
            .map(str::trim)
            .find_map(|directive| directive.strip_prefix("frame-ancestors"))
            .is_some_and(|sources| !sources.split_whitespace().any(|source| source == "*"))
    });

    if frame_option || frame_policy {
        Probe::Unframeable
    } else {
        Probe::Page
    }
}

/// Checks an address the server printed (or its port) in the background, and
/// shows it only once it serves a web page. Addresses that never do, such as
/// an API or a websocket port, are noted in the log and left out.
fn offer_url(
    app: &impl Events,
    dev: &Arc<Mutex<Option<DevServer>>>,
    logs: &Arc<Mutex<VecDeque<String>>>,
    pid: Option<u32>,
    url: String,
) {
    {
        let Ok(mut guard) = dev.lock() else { return };
        let Some(server) = guard.as_mut().filter(|server| Some(server.child.id()) == pid) else {
            return;
        };
        if server.url.is_some() || server.offered.contains(&url) {
            return;
        }
        server.offered.push(url.clone());
    }

    let app = app.clone();
    let dev = dev.clone();
    let logs = logs.clone();

    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        let mut last = Probe::NoAnswer;

        while std::time::Instant::now() < deadline {
            let waiting = dev.lock().ok().is_some_and(|guard| {
                guard
                    .as_ref()
                    .is_some_and(|server| Some(server.child.id()) == pid && server.url.is_none())
            });
            if !waiting {
                return;
            }

            match probe(&url) {
                Probe::Page => {
                    set_url(&app, &dev, pid, url);
                    return;
                }
                Probe::Unframeable => {
                    set_blocked(&app, &dev, pid, url);
                    return;
                }
                other => last = other,
            }
            std::thread::sleep(Duration::from_secs(1));
        }

        if let Probe::NotPage(what) = last {
            log(&app, &logs, format!("[{url} answered with {what}, not a web page, so it is not previewed]"));
        }
    });
}

/// Records a page that cannot be shown in the panel, for "Open in browser".
fn set_blocked(app: &impl Events, dev: &Mutex<Option<DevServer>>, pid: Option<u32>, url: String) {
    if let Ok(mut guard) = dev.lock() {
        if let Some(server) = guard.as_mut().filter(|server| Some(server.child.id()) == pid) {
            if server.url.is_none() && server.blocked_url.is_none() {
                server.blocked_url = Some(url.clone());
                app.send("web:blocked", url);
            }
        }
    }
}

/// Records the address to preview, the first one found for this server.
fn set_url(app: &impl Events, dev: &Mutex<Option<DevServer>>, pid: Option<u32>, url: String) {
    if let Ok(mut guard) = dev.lock() {
        if let Some(server) = guard.as_mut().filter(|server| Some(server.child.id()) == pid) {
            if server.url.is_none() {
                server.url = Some(url.clone());
                app.send("web:url", url);
            }
        }
    }
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
        assert_eq!(info.apps[0].package_manager, usable_manager("pnpm".into()));
        assert_eq!(info.pages, vec!["site/index.html", "site/about/index.html"]);
    }

    fn app_with(name: &str, package: &str, files: &[(&str, &str)]) -> Option<WebApp> {
        let root = std::env::temp_dir().join(format!("nexium-app-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("package.json"), package).unwrap();
        for (file, text) in files {
            fs::write(root.join(file), text).unwrap();
        }

        let app = read_app(&root, &root);
        let _ = fs::remove_dir_all(&root);
        app
    }

    fn server_names(app: &WebApp) -> Vec<&str> {
        app.servers.iter().map(|script| script.name.as_str()).collect()
    }

    /// The scripts of this very repository: only the Vite servers are
    /// offered, `dev` first, with the port from vite.config.ts.
    #[test]
    fn offers_only_server_scripts_for_nexium_itself() {
        let app = app_with(
            "nexium",
            r#"{"name":"nexium-ide","scripts":{
                "dev":"vite","dev:desktop":"vite --mode desktop",
                "build":"tsc --noEmit && vite build","preview":"vite preview",
                "tauri":"tauri","desktop":"node scripts/desktop-dev.mjs","desktop:build":"tauri build"},
              "devDependencies":{"vite":"^8"}}"#,
            &[
                ("bun.lock", ""),
                (
                    "vite.config.ts",
                    "export default defineConfig({ server: {\n  host: \"127.0.0.1\",\n  // a free port the OS picked\n  port: 5180,\n  strictPort: true,\n} });",
                ),
            ],
        )
        .unwrap();

        assert_eq!(server_names(&app), vec!["dev", "preview"]);
        assert_eq!(app.preferred.as_deref(), Some("dev"));
        assert_eq!(app.package_manager, usable_manager("bun".into()));
        assert_eq!(app.servers[0].port, Some(5180));
        assert_eq!(app.servers[1].port, Some(4173));
        assert_eq!(app.fallback, None);
    }

    #[test]
    fn ranks_servers_across_project_shapes() {
        let next = app_with(
            "next",
            r#"{"scripts":{"build":"next build","start":"next start","lint":"next lint","dev":"next dev -p 3001"},"dependencies":{"next":"15"}}"#,
            &[("pnpm-lock.yaml", ""), ("package-lock.json", "")],
        )
        .unwrap();
        assert_eq!(server_names(&next), vec!["dev", "start"]);
        assert_eq!(next.servers[0].port, Some(3001));
        assert_eq!(next.package_manager, usable_manager("pnpm".into()));

        let express = app_with(
            "express",
            r#"{"packageManager":"yarn@4.1.0","scripts":{"start":"node server.js","test":"jest"}}"#,
            &[("package-lock.json", "")],
        )
        .unwrap();
        assert_eq!(server_names(&express), vec!["start"]);
        assert_eq!(express.package_manager, usable_manager("yarn".into()));

        let bare_vite = app_with("bare", r#"{"devDependencies":{"vite":"5"}}"#, &[]).unwrap();
        assert!(bare_vite.servers.is_empty());
        assert_eq!(bare_vite.fallback.as_deref(), Some("npx vite"));
        assert_eq!(bare_vite.package_manager, "npm");

        let wrapper = app_with(
            "wrapper",
            r#"{"scripts":{"dev":"tauri dev","build":"tsc","watch":"tsc -w","check":"svelte-check"}}"#,
            &[],
        );
        assert!(wrapper.is_none(), "a Tauri wrapper and builders are not web servers");

        let combined = app_with(
            "combined",
            r#"{"scripts":{"serve:prod":"vite build && vite preview","dev":"vitest"}}"#,
            &[],
        )
        .unwrap();
        assert_eq!(server_names(&combined), vec!["serve:prod"]);
    }

    #[test]
    fn reads_the_package_manager_from_the_lock_file() {
        let root = std::env::temp_dir().join(format!("nexium-locks-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("web")).unwrap();
        let web = root.join("web");
        fs::write(web.join("package.json"), "{}").unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();

        let mut found = vec![package_manager(&web, &root)];
        fs::write(root.join("yarn.lock"), "").unwrap();
        found.push(package_manager(&web, &root));
        fs::write(web.join("bun.lock"), "").unwrap();
        fs::write(web.join("package-lock.json"), "").unwrap();
        found.push(package_manager(&web, &root));
        fs::write(web.join("package.json"), r#"{"packageManager":"pnpm@9.0.0"}"#).unwrap();
        found.push(package_manager(&web, &root));
        let _ = fs::remove_dir_all(&root);

        assert_eq!(found, vec!["npm", "yarn", "bun", "pnpm"]);
        assert_eq!(usable_manager("npm".into()), "npm");
        assert_eq!(usable_manager("not-a-manager".into()), if locate_manager("npm").is_some() { "npm" } else { "not-a-manager" });
    }

    #[test]
    fn previews_only_web_pages() {
        let page = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n";
        assert_eq!(page_kind(page), Probe::Page);
        assert_eq!(page_kind("HTTP/1.1 302 Found\r\nLocation: /app\r\n\r\n"), Probe::Page);
        assert_eq!(
            page_kind("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"),
            Probe::NotPage("status 200 (application/json)".into())
        );
        assert_eq!(page_kind("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\n"), Probe::NotPage("status 404 (text/html)".into()));
        assert_eq!(page_kind("HTTP/1.1 426 Upgrade Required\r\n\r\n"), Probe::NotPage("status 426".into()));
        assert_eq!(page_kind(""), Probe::NoAnswer);
        assert_eq!(page_kind("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Frame-Options: DENY\r\n\r\n"), Probe::Unframeable);
        assert_eq!(
            page_kind("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'self'\r\n\r\n"),
            Probe::Unframeable
        );
        assert_eq!(
            page_kind("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: frame-ancestors *\r\n\r\n"),
            Probe::Page
        );

        // A real socket: an API answering JSON is not previewed, a page is.
        let serve = |body_type: &'static str| {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buffer = [0u8; 1024];
                    let _ = stream.read(&mut buffer);
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {body_type}\r\nContent-Length: 2\r\n\r\nok");
                }
            });
            format!("http://localhost:{port}/")
        };
        assert_eq!(probe(&serve("text/html")), Probe::Page);
        assert!(matches!(probe(&serve("application/json")), Probe::NotPage(_)));
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert_eq!(probe(&format!("http://127.0.0.1:{closed}/")), Probe::NoAnswer);
    }

    #[test]
    fn custom_commands_that_are_not_servers_expect_no_preview() {
        let root = std::env::temp_dir().join(format!("nexium-custom-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let state = WebState::default();

        let started = start_dev(&Recorder::default(), &state, &root, "", "", Some("echo hello"), None).unwrap();
        assert!(!started.expects_preview);
        stop_dev(&state);

        assert!(expected_port(&root, "npx vite --host").is_some(), "a known server expects a preview");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn moves_servers_off_a_taken_port() {
        assert_eq!(port_flag("vite --port 4000"), Some(4000));
        assert_eq!(port_flag("next dev -p=3000"), None);
        assert_eq!(port_flag("astro dev --port=4322"), Some(4322));
        assert_eq!(port_args(Some("vite"), 5174), vec!["--port", "5174"]);
        assert!(port_args(Some("react-scripts start"), 3001).is_empty());
        assert_eq!(script_args("npm", "dev", &["--port".into(), "5174".into()]), vec!["run", "dev", "--", "--port", "5174"]);
        assert_eq!(script_args("bun", "dev", &["--port".into(), "5174".into()]), vec!["run", "dev", "--port", "5174"]);
        assert_eq!(script_args("yarn", "dev", &[]), vec!["dev"]);
        assert!(missing_manager("bun", Some("dev")).contains("\"npm run dev\""));
        assert!(start_dev(&Recorder::default(), &WebState::default(), Path::new("."), "", "dev", None, Some("calc")).is_err());

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_taken(port));
        let free = free_port_after(port).unwrap();
        assert_ne!(free, port);
        assert!(!port_taken(free));
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
                "const http=require('http');http.createServer((q,s)=>{{s.setHeader('Content-Type','text/html');s.end('<p>ok</p>')}}).listen({port},()=>console.log('\x1b[32m  Local:\x1b[0m   http://localhost:{port}/'));"
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
        start_dev(&events, &state, &root, "", "dev", None, None).unwrap();

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

    /// Starts this repository's own `dev` script (Vite with strictPort on
    /// 5173) while something else holds 5173, as a second copy would.
    #[test]
    #[ignore = "needs this repo's node_modules and its package manager on PATH"]
    fn previews_this_repo_with_its_port_taken() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let app = read_app(&root, &root).unwrap();
        assert_eq!(app.preferred.as_deref(), Some("dev"));

        let blocker = TcpListener::bind(("127.0.0.1", 5173)).ok();
        assert!(port_taken(5173));

        let events = Recorder::default();
        let state = WebState::default();
        start_dev(&events, &state, &root, "", "dev", None, None).unwrap();

        let mut url = None;
        for _ in 0..900 {
            std::thread::sleep(Duration::from_millis(100));
            url = status(&state).dev.and_then(|dev| dev.url);
            if url.is_some() {
                break;
            }
        }
        let logs = status(&state).logs;
        let url = url.unwrap_or_else(|| panic!("no address; logs: {logs:?}"));
        assert!(!url.contains(":5173"), "{url}");

        let address = url.trim_start_matches("http://").trim_end_matches('/');
        let mut stream = TcpStream::connect(address).unwrap();
        write!(stream, "GET / HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").unwrap();
        let mut page = String::new();
        let _ = stream.read_to_string(&mut page);

        stop_dev(&state);
        drop(blocker);

        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("<div id=\"root\">") || page.contains("id=\"root\""), "{page}");
        eprintln!("logs: {logs:#?}");
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
