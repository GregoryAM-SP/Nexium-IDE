//! Projects that run as programs rather than web pages (Rust, Go, .NET,
//! Python scripts, C/C++ with CMake, Node scripts, Flutter on the desktop),
//! with the commands the Run panel offers for each.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::web;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// "Run", "Test", "Build"…
    pub name: String,
    pub command: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Runnable {
    /// Folder relative to the workspace root, empty for the root.
    pub dir: String,
    pub name: String,
    /// "Rust", "Go", ".NET", "Python", "C++ (CMake)", "Node.js", "Flutter".
    pub kind: String,
    /// The first task is the default.
    pub tasks: Vec<Task>,
}

fn task(name: &str, command: impl Into<String>) -> Task {
    Task { name: name.into(), command: command.into() }
}

/// Folders never searched.
const SKIPPED: [&str; 12] = [
    "node_modules", "target", "dist", "build", "out", "bin", "obj", "vendor", ".venv", "venv", "env", "__pycache__",
];

fn skipped(name: &str) -> bool {
    name.starts_with('.') || SKIPPED.contains(&name)
}

fn file_name(dir: &Path) -> String {
    dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "app".into())
}

/// `name = "value"` from the `[section]` of a TOML file (a plain search).
fn toml_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == format!("[{section}]");
            continue;
        }
        if inside {
            if let Some(rest) = line.strip_prefix(key) {
                let value = rest.trim_start().strip_prefix('=')?.trim().trim_matches('"');
                return Some(value.to_string());
            }
        }
    }
    None
}

fn rust(dir: &Path) -> Option<Runnable> {
    let manifest = fs::read_to_string(dir.join("Cargo.toml")).ok()?;
    let package = toml_value(&manifest, "package", "name");
    let workspace_only = package.is_none() && manifest.contains("[workspace]");
    // A library has nothing to run, only to test and build.
    let runnable = !workspace_only
        && (dir.join("src/main.rs").is_file() || manifest.contains("[[bin]]") || dir.join("src/bin").is_dir());

    let mut tasks = Vec::new();
    if runnable {
        tasks.push(task("Run", "cargo run"));
        tasks.push(task("Run (release)", "cargo run --release"));
    }
    tasks.extend([task("Test", "cargo test"), task("Build", "cargo build"), task("Check", "cargo check")]);

    Some(Runnable { dir: String::new(), name: package.unwrap_or_else(|| file_name(dir)), kind: "Rust".into(), tasks })
}

fn go(dir: &Path) -> Option<Runnable> {
    let module = fs::read_to_string(dir.join("go.mod")).ok()?;
    let name = module
        .lines()
        .find_map(|line| line.strip_prefix("module "))
        .map(|name| name.trim().rsplit('/').next().unwrap_or(name).to_string())
        .unwrap_or_else(|| file_name(dir));
    let has_main = fs::read_dir(dir).ok()?.flatten().any(|entry| {
        entry.path().extension().is_some_and(|ext| ext == "go")
            && fs::read_to_string(entry.path()).is_ok_and(|text| text.contains("package main"))
    });
    let mut tasks = Vec::new();
    if has_main {
        tasks.push(task("Run", "go run ."));
    }
    tasks.extend([task("Test", "go test ./..."), task("Build", "go build ./..."), task("Vet", "go vet ./...")]);
    Some(Runnable { dir: String::new(), name, kind: "Go".into(), tasks })
}

fn dotnet(dir: &Path) -> Option<Runnable> {
    let project = fs::read_dir(dir).ok()?.flatten().map(|entry| entry.path()).find(|path| {
        path.extension().is_some_and(|ext| ext == "csproj" || ext == "fsproj" || ext == "vbproj" || ext == "sln" || ext == "slnx")
    })?;
    let solution = project.extension().is_some_and(|ext| ext == "sln" || ext == "slnx");
    let name = project.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| file_name(dir));
    let mut tasks = Vec::new();
    if !solution {
        tasks.push(task("Run", "dotnet run"));
        tasks.push(task("Watch", "dotnet watch run"));
    }
    tasks.extend([task("Test", "dotnet test"), task("Build", "dotnet build")]);
    Some(Runnable { dir: String::new(), name, kind: ".NET".into(), tasks })
}

fn cmake(dir: &Path) -> Option<Runnable> {
    let lists = fs::read_to_string(dir.join("CMakeLists.txt")).ok()?;
    let executable = lists.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("add_executable(")?;
        let name = rest.split(|c: char| c.is_whitespace() || c == ')').next()?.trim();
        (!name.is_empty() && !name.contains('$')).then(|| name.to_string())
    });
    let build = "cmake -S . -B build && cmake --build build";
    let mut tasks = Vec::new();
    if let Some(exe) = &executable {
        let run = if cfg!(windows) {
            // Visual Studio builds go to build\Debug, Ninja and Make to build.
            format!("{build} && if exist build\\Debug\\{exe}.exe (build\\Debug\\{exe}.exe) else (build\\{exe}.exe)")
        } else {
            format!("{build} && ./build/{exe}")
        };
        tasks.push(task("Run", run));
    }
    tasks.push(task("Build", build));
    tasks.push(task("Test", "cmake --build build && ctest --test-dir build --output-on-failure"));
    Some(Runnable { dir: String::new(), name: executable.unwrap_or_else(|| file_name(dir)), kind: "C++ (CMake)".into(), tasks })
}

fn node(dir: &Path) -> Option<Runnable> {
    let text = fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let scripts = json.get("scripts").and_then(|scripts| scripts.as_object());
    let manager = if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if dir.join("yarn.lock").is_file() {
        "yarn"
    } else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    };
    let run = |script: &str| if manager == "yarn" { format!("yarn {script}") } else { format!("{manager} run {script}") };

    let mut tasks: Vec<Task> = Vec::new();
    // A script that is not in package.json but is the package's entry point.
    if scripts.is_none_or(|scripts| !scripts.contains_key("start")) {
        if let Some(main) = json.get("main").and_then(|main| main.as_str()) {
            tasks.push(task("Run", format!("node {main}")));
        } else if dir.join("index.js").is_file() {
            tasks.push(task("Run", "node index.js"));
        }
    }
    if let Some(scripts) = scripts {
        // start and test first, the rest in package.json's order.
        let mut names: Vec<&String> = scripts.keys().collect();
        names.sort_by_key(|name| match name.as_str() {
            "start" => 0,
            "dev" => 1,
            "test" => 2,
            "build" => 3,
            _ => 4,
        });
        for name in names {
            let label = if name == "start" { "Start".to_string() } else { name.clone() };
            tasks.push(Task { name: label, command: run(name) });
        }
    }
    if tasks.is_empty() {
        return None;
    }
    let name = json.get("name").and_then(|name| name.as_str()).map(str::to_string).unwrap_or_else(|| file_name(dir));
    Some(Runnable { dir: String::new(), name, kind: "Node.js".into(), tasks })
}

fn flutter(dir: &Path) -> Option<Runnable> {
    let pubspec = fs::read_to_string(dir.join("pubspec.yaml")).ok()?;
    let is_flutter = pubspec.lines().any(|line| line.trim().replace(' ', "") == "sdk:flutter");
    let name = pubspec
        .lines()
        .find_map(|line| line.strip_prefix("name:"))
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|| file_name(dir));
    if !is_flutter {
        // A Dart package or command-line app.
        let mut tasks = Vec::new();
        if dir.join("bin").is_dir() {
            tasks.push(task("Run", "dart run"));
        }
        tasks.extend([task("Test", "dart test"), task("Analyze", "dart analyze")]);
        return Some(Runnable { dir: String::new(), name, kind: "Dart".into(), tasks });
    }

    let mut tasks = Vec::new();
    let desktop = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    if dir.join(desktop).is_dir() {
        tasks.push(task("Run on this computer", format!("flutter run -d {desktop}")));
    }
    tasks.extend([
        task("Run (choose a device)", "flutter devices && flutter run"),
        task("Test", "flutter test"),
        task("Analyze", "flutter analyze"),
        task("Build web", "flutter build web"),
        task("Get packages", "flutter pub get"),
    ]);
    Some(Runnable { dir: String::new(), name, kind: "Flutter".into(), tasks })
}

/// A Gradle build (Java, Kotlin, Android), run through its wrapper when it has one.
fn gradle(dir: &Path) -> Option<Runnable> {
    let build_files = ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"];
    if !build_files.iter().any(|file| dir.join(file).is_file()) {
        return None;
    }
    // The wrapper, else Gradle on PATH, else a distribution another
    // project's wrapper already downloaded.
    let gradle = if dir.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" }).is_file() {
        if cfg!(windows) { "gradlew.bat".to_string() } else { "./gradlew".to_string() }
    } else {
        crate::templates::find_gradle().map(|(gradle, _)| gradle).unwrap_or_else(|| "gradle".into())
    };
    // The application or Android plugin, in the root build or a module (app/).
    let scripts: Vec<String> = ["build.gradle.kts", "build.gradle", "app/build.gradle.kts", "app/build.gradle"]
        .iter()
        .filter_map(|file| fs::read_to_string(dir.join(file)).ok())
        .collect();
    let has = |needle: &str| scripts.iter().any(|script| script.contains(needle));
    let name = ["settings.gradle.kts", "settings.gradle"]
        .iter()
        .filter_map(|file| fs::read_to_string(dir.join(file)).ok())
        .find_map(|text| {
            let line = text.lines().find(|line| line.contains("rootProject.name"))?;
            Some(line.split(['"', '\'']).nth(1)?.to_string())
        })
        .unwrap_or_else(|| file_name(dir));

    let mut tasks = Vec::new();
    if has("com.android.application") {
        tasks.push(task("Install on device", format!("{gradle} installDebug")));
        tasks.push(task("Build APK", format!("{gradle} assembleDebug")));
    } else if has("application") {
        tasks.push(task("Run", format!("{gradle} run --console=plain")));
    }
    tasks.extend([
        task("Test", format!("{gradle} test")),
        task("Build", format!("{gradle} build")),
        task("Clean", format!("{gradle} clean")),
    ]);
    let kind = if has("kotlin(") || has("org.jetbrains.kotlin") { "Kotlin (Gradle)" } else { "Java (Gradle)" };
    let kind = if has("com.android.application") { "Android (Gradle)" } else { kind };
    Some(Runnable { dir: String::new(), name, kind: kind.into(), tasks })
}

/// A Python program that is not a web app (those run in the preview).
fn python(dir: &Path) -> Option<Runnable> {
    let entry = ["main.py", "app.py", "run.py", "cli.py", "__main__.py"]
        .into_iter()
        .find(|file| dir.join(file).is_file());
    let tests = dir.join("tests").is_dir()
        || dir.join("test").is_dir()
        || fs::read_dir(dir).ok()?.flatten().any(|entry| entry.file_name().to_string_lossy().starts_with("test_"));
    let pyproject = dir.join("pyproject.toml").is_file();
    if entry.is_none() && !tests && !pyproject {
        return None;
    }
    let python = web::python_for(dir);
    let mut tasks = Vec::new();
    if let Some(entry) = entry {
        tasks.push(task("Run", format!("{python} {entry}")));
    }
    if tests {
        tasks.push(task("Test", format!("{python} -m pytest")));
    }
    if dir.join("requirements.txt").is_file() {
        tasks.push(task("Install requirements", format!("{python} -m pip install -r requirements.txt")));
    }
    if tasks.is_empty() {
        return None;
    }
    Some(Runnable { dir: String::new(), name: file_name(dir), kind: "Python".into(), tasks })
}

/// Everything runnable in `dir`, most specific first.
fn read(root: &Path, dir: &Path) -> Vec<Runnable> {
    let relative = dir
        .strip_prefix(root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    [rust(dir), go(dir), dotnet(dir), gradle(dir), flutter(dir), cmake(dir), python(dir), node(dir)]
        .into_iter()
        .flatten()
        .map(|mut runnable| {
            runnable.dir = relative.clone();
            runnable
        })
        .collect()
}

/// The runnable projects in the workspace: the root and the folders up to
/// two levels below it (`backend/`, `apps/cli`, `src-tauri`).
pub fn detect(root: &Path) -> Vec<Runnable> {
    let mut found = read(root, root);
    let children = |dir: &Path| -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir() && !path.file_name().is_some_and(|name| skipped(&name.to_string_lossy())))
                    .collect()
            })
            .unwrap_or_default();
        dirs.sort();
        dirs
    };
    for dir in children(root) {
        let here = read(root, &dir);
        if here.is_empty() {
            for nested in children(&dir) {
                found.extend(read(root, &nested));
            }
        } else {
            found.extend(here);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_runnable_projects() {
        let root = std::env::temp_dir().join(format!("nexium-runnable-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for dir in ["cli/src", "lib/src", "service", "tool", "native/src", "scripts/tests", "site", "apps/api/Api"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("cli/Cargo.toml"), "[package]\nname = \"hello-cli\"\nversion = \"0.1.0\"\n").unwrap();
        fs::write(root.join("cli/src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("lib/Cargo.toml"), "[package]\nname = \"helpers\"\n").unwrap();
        fs::write(root.join("lib/src/lib.rs"), "").unwrap();
        fs::write(root.join("service/go.mod"), "module example.com/team/service\n\ngo 1.22\n").unwrap();
        fs::write(root.join("service/main.go"), "package main\nfunc main() {}\n").unwrap();
        fs::write(root.join("tool/Tool.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>").unwrap();
        fs::write(root.join("native/CMakeLists.txt"), "project(native)\nadd_executable(native_app src/main.cpp)\n").unwrap();
        fs::write(root.join("scripts/main.py"), "print('hi')").unwrap();
        fs::create_dir_all(root.join("jvm")).unwrap();
        fs::write(root.join("jvm/settings.gradle.kts"), "rootProject.name = \"hello-jvm\"
").unwrap();
        fs::write(root.join("jvm/build.gradle.kts"), "plugins {
    kotlin(\"jvm\") version \"2.2.20\"
    application
}
").unwrap();
        fs::write(root.join("jvm/gradlew.bat"), "").unwrap();
        fs::write(root.join("jvm/gradlew"), "").unwrap();
        fs::write(root.join("site/package.json"), r#"{"name":"site","scripts":{"build":"tsc","test":"vitest","start":"node server.js"}}"#).unwrap();

        let found = detect(&root);
        let by_dir = |dir: &str| found.iter().find(|runnable| runnable.dir == dir).unwrap_or_else(|| panic!("{dir} missing"));

        let cli = by_dir("cli");
        assert_eq!((cli.kind.as_str(), cli.name.as_str()), ("Rust", "hello-cli"));
        assert_eq!(cli.tasks[0], task("Run", "cargo run"));
        let lib = by_dir("lib");
        assert_eq!(lib.tasks[0].name, "Test", "a library has nothing to run");
        let service = by_dir("service");
        assert_eq!((service.name.as_str(), service.tasks[0].command.as_str()), ("service", "go run ."));
        let tool = by_dir("tool");
        assert_eq!((tool.kind.as_str(), tool.tasks[0].command.as_str()), (".NET", "dotnet run"));
        let native = by_dir("native");
        assert_eq!(native.name, "native_app");
        assert!(native.tasks[0].command.contains("native_app"));
        let scripts = by_dir("scripts");
        assert!(scripts.tasks[0].command.ends_with(" main.py"));
        assert!(scripts.tasks.iter().any(|task| task.name == "Test"));
        let site = by_dir("site");
        let names: Vec<&str> = site.tasks.iter().map(|task| task.name.as_str()).collect();
        assert_eq!(names, ["Start", "test", "build"]);
        assert!(found.iter().all(|runnable| runnable.dir != "apps"), "an empty folder is not a project");
        let jvm = by_dir("jvm");
        assert_eq!((jvm.kind.as_str(), jvm.name.as_str()), ("Kotlin (Gradle)", "hello-jvm"));
        let wrapper = if cfg!(windows) { "gradlew.bat run" } else { "./gradlew run" };
        assert!(jvm.tasks[0].command.starts_with(wrapper), "{}", jvm.tasks[0].command);
        let _ = fs::remove_dir_all(&root);
    }
}
