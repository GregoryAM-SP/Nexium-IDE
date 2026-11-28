//! Project templates for New Project: small built-in starters written from
//! files embedded in the app (they work offline), and the official
//! generators of frameworks that change too often to ship a copy of
//! (`npm create vite`, `flutter create`, `cargo new`…), run with their output
//! shown as it arrives.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::template_files::FILES;

/// How a template's project name has to look.
#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum NameRule {
    /// Any valid folder name.
    Folder,
    /// Lowercase letters, digits, `-`, `_` and `.` (npm and cargo package names).
    Package,
    /// Lowercase letters, digits and `_`, starting with a letter (Dart packages).
    Snake,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    /// `builtin` (files from the app) or `generator` (the framework's own tool).
    pub kind: &'static str,
    /// Tools that must be installed to create the project.
    pub requires: Vec<&'static str>,
    /// Tools needed later to run it (shown as a hint, not required).
    pub runs_with: Vec<&'static str>,
    /// Offers a TypeScript / JavaScript choice.
    pub typescript: bool,
    /// Offers installing dependencies right away.
    pub install: bool,
    pub name_rule: NameRule,
    /// What creating it runs, for the dialog to show, for `my-app`:
    /// [TypeScript + install, TypeScript, JavaScript + install, JavaScript].
    pub commands: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
struct Spec {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    description: &'static str,
    generator: bool,
    requires: &'static [&'static str],
    runs_with: &'static [&'static str],
    typescript: bool,
    install: bool,
    name_rule: NameRule,
}

const SPECS: &[Spec] = &[
    // Web
    Spec { id: "html", name: "HTML, CSS & JavaScript", category: "Web", description: "A plain static site: index.html, a stylesheet and a script. Nothing to install.", generator: false, requires: &[], runs_with: &[], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "bootstrap", name: "Bootstrap", category: "Web", description: "A responsive Bootstrap 5 landing page with a navbar, hero and footer, loaded from a CDN.", generator: false, requires: &[], runs_with: &[], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "tailwind", name: "Tailwind CSS", category: "Web", description: "A page styled with Tailwind CSS from a CDN, for quick prototypes.", generator: false, requires: &[], runs_with: &[], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "vite-react", name: "React (Vite)", category: "Web", description: "A React app with Vite's dev server and fast refresh, from create-vite.", generator: true, requires: &["npm"], runs_with: &["node"], typescript: true, install: true, name_rule: NameRule::Package },
    Spec { id: "next", name: "Next.js", category: "Web", description: "A Next.js app with the App Router, ESLint and Tailwind, from create-next-app.", generator: true, requires: &["npx"], runs_with: &["node"], typescript: true, install: true, name_rule: NameRule::Package },
    Spec { id: "vite-vue", name: "Vue (Vite)", category: "Web", description: "A Vue 3 app with Vite, from create-vite.", generator: true, requires: &["npm"], runs_with: &["node"], typescript: true, install: true, name_rule: NameRule::Package },
    Spec { id: "vite-svelte", name: "Svelte (Vite)", category: "Web", description: "A Svelte app with Vite, from create-vite.", generator: true, requires: &["npm"], runs_with: &["node"], typescript: true, install: true, name_rule: NameRule::Package },
    Spec { id: "angular", name: "Angular", category: "Web", description: "An Angular app with the default setup, from the Angular CLI.", generator: true, requires: &["npx"], runs_with: &["node"], typescript: false, install: true, name_rule: NameRule::Package },
    Spec { id: "vite-vanilla", name: "Vite (no framework)", category: "Web", description: "Vite's dev server and build with plain JavaScript or TypeScript.", generator: true, requires: &["npm"], runs_with: &["node"], typescript: true, install: true, name_rule: NameRule::Package },
    // Mobile
    Spec { id: "expo", name: "React Native (Expo)", category: "Mobile", description: "A React Native app for iOS, Android and the web, from create-expo-app.", generator: true, requires: &["npx"], runs_with: &["node"], typescript: true, install: true, name_rule: NameRule::Package },
    Spec { id: "flutter", name: "Flutter", category: "Mobile", description: "A Flutter app for mobile, desktop and the web, from flutter create.", generator: true, requires: &["flutter"], runs_with: &["flutter"], typescript: false, install: true, name_rule: NameRule::Snake },
    // Backend
    Spec { id: "express", name: "Node.js + Express", category: "Backend", description: "A small JSON API with Express 5.", generator: false, requires: &[], runs_with: &["node"], typescript: false, install: true, name_rule: NameRule::Package },
    Spec { id: "fastapi", name: "FastAPI", category: "Backend", description: "A Python API with FastAPI and interactive docs.", generator: false, requires: &[], runs_with: &["python"], typescript: false, install: true, name_rule: NameRule::Folder },
    Spec { id: "flask", name: "Flask", category: "Backend", description: "A Python web app with Flask, a template and static files.", generator: false, requires: &[], runs_with: &["python"], typescript: false, install: true, name_rule: NameRule::Folder },
    Spec { id: "dotnet-webapi", name: "ASP.NET Core Web API", category: "Backend", description: "A C# web API, from dotnet new webapi.", generator: true, requires: &["dotnet"], runs_with: &["dotnet"], typescript: false, install: false, name_rule: NameRule::Folder },
    // Desktop & systems
    Spec { id: "rust", name: "Rust", category: "Systems", description: "A Rust program with Cargo, from cargo new.", generator: true, requires: &["cargo"], runs_with: &["cargo"], typescript: false, install: false, name_rule: NameRule::Package },
    Spec { id: "go", name: "Go", category: "Systems", description: "A Go module with a main package.", generator: false, requires: &[], runs_with: &["go"], typescript: false, install: false, name_rule: NameRule::Package },
    Spec { id: "cpp", name: "C++ (CMake)", category: "Systems", description: "A C++20 program built with CMake.", generator: false, requires: &[], runs_with: &["cmake"], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "dotnet-console", name: "C# console app", category: "Systems", description: "A .NET console program, from dotnet new console.", generator: true, requires: &["dotnet"], runs_with: &["dotnet"], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "java-gradle", name: "Java (Gradle)", category: "Systems", description: "A Java application with a Kotlin-DSL Gradle build, a JUnit 5 test and the Gradle wrapper.", generator: false, requires: &[], runs_with: &["java"], typescript: false, install: false, name_rule: NameRule::Package },
    Spec { id: "kotlin-gradle", name: "Kotlin (Gradle)", category: "Systems", description: "A Kotlin/JVM application with a Kotlin-DSL Gradle build, a test and the Gradle wrapper.", generator: false, requires: &[], runs_with: &["java"], typescript: false, install: false, name_rule: NameRule::Package },
    // Other
    Spec { id: "python", name: "Python script", category: "Other", description: "A Python script with a main function.", generator: false, requires: &[], runs_with: &["python"], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "docs", name: "Documentation", category: "Other", description: "Markdown pages with a README and a docs folder.", generator: false, requires: &[], runs_with: &[], typescript: false, install: false, name_rule: NameRule::Folder },
    Spec { id: "blank", name: "Empty folder", category: "Other", description: "Nothing but the folder.", generator: false, requires: &[], runs_with: &[], typescript: false, install: false, name_rule: NameRule::Folder },
];

/// What the user chose in the dialog.
#[derive(Clone, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub template: String,
    /// The folder the project is created in.
    pub parent: String,
    pub name: String,
    #[serde(default = "yes")]
    pub typescript: bool,
    #[serde(default)]
    pub install: bool,
    #[serde(default)]
    pub git: bool,
}

fn yes() -> bool {
    true
}

/// One command of the plan, run in `parent` or in the new project folder.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub title: String,
    pub command: String,
    pub in_project: bool,
}

/// What creating the project does.
#[derive(Debug)]
pub struct Plan {
    pub template: &'static str,
    pub folder: PathBuf,
    /// Files written before the steps (built-in templates).
    pub files: Vec<(String, String)>,
    pub steps: Vec<Step>,
    pub git: bool,
}

pub fn catalog() -> Vec<Template> {
    SPECS
        .iter()
        .map(|spec| Template {
            id: spec.id,
            name: spec.name,
            category: spec.category,
            description: spec.description,
            kind: if spec.generator { "generator" } else { "builtin" },
            requires: spec.requires.to_vec(),
            runs_with: spec.runs_with.to_vec(),
            typescript: spec.typescript,
            install: spec.install,
            name_rule: spec.name_rule,
            commands: [(true, true), (true, false), (false, true), (false, false)]
                .iter()
                .filter_map(|(typescript, install)| generator_command(spec.id, "my-app", *typescript, *install))
                .collect(),
        })
        .collect()
}

fn spec(id: &str) -> Result<&'static Spec, String> {
    SPECS
        .iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| format!("There is no template called '{id}'."))
}

/// The framework generator's command, run in the parent folder; it creates
/// the project folder `name` itself.
fn generator_command(id: &str, name: &str, typescript: bool, install: bool) -> Option<String> {
    let ts = |with: &str, without: &str| if typescript { with.to_string() } else { without.to_string() };
    Some(match id {
        "vite-react" => format!("npm create vite@latest {name} -- --template {} --no-interactive", ts("react-ts", "react")),
        "vite-vue" => format!("npm create vite@latest {name} -- --template {} --no-interactive", ts("vue-ts", "vue")),
        "vite-svelte" => format!("npm create vite@latest {name} -- --template {} --no-interactive", ts("svelte-ts", "svelte")),
        "vite-vanilla" => format!("npm create vite@latest {name} -- --template {} --no-interactive", ts("vanilla-ts", "vanilla")),
        "next" => format!(
            "npx --yes create-next-app@latest {name} {} --app --eslint --tailwind --src-dir --import-alias \"@/*\" --use-npm --disable-git --yes{}",
            ts("--ts", "--js"),
            if install { "" } else { " --skip-install" }
        ),
        "angular" => format!(
            "npx --yes @angular/cli@latest new {name} --defaults --skip-git --ssr=false{}",
            if install { "" } else { " --skip-install" }
        ),
        "expo" => format!(
            "npx --yes create-expo-app@latest {name} --template {}{}",
            ts("blank-typescript", "blank"),
            if install { "" } else { " --no-install" }
        ),
        "flutter" => format!("flutter create {name}{}", if install { "" } else { " --no-pub" }),
        "rust" => format!("cargo new {name} --vcs none"),
        "dotnet-console" => format!("dotnet new console -o {name}"),
        "dotnet-webapi" => format!("dotnet new webapi -o {name}"),
        _ => return None,
    })
}

/// Why `name` cannot be used for this template, if it cannot.
pub fn name_problem(name: &str, rule: NameRule) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return Some("Give the project a name.".into());
    }
    if name.len() > 100 {
        return Some("That name is too long.".into());
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
        || name.ends_with('.')
        || name.ends_with(' ')
        || name.starts_with('.')
    {
        return Some("A folder name cannot contain < > : \" / \\ | ? * or start or end with a dot.".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Some(format!("{name} is a reserved name on Windows."));
    }

    match rule {
        NameRule::Folder => None,
        NameRule::Package => {
            let ok = name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
                && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            (!ok).then(|| "Use lowercase letters, digits and dashes for this template (for example my-app).".into())
        }
        NameRule::Snake => {
            let ok = name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                && name.chars().next().is_some_and(|c| c.is_ascii_lowercase());
            (!ok).then(|| "Flutter needs lowercase letters, digits and underscores, starting with a letter (for example my_app).".into())
        }
    }
}

/// "Nexium Studio" from "nexium-studio" or "nexium_studio".
fn title(name: &str) -> String {
    name.split(['-', '_', ' ', '.'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// "nexium-studio" from "Nexium Studio".
fn package(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "app".into() } else { out }
}

/// "nexium_studio" from "Nexium Studio".
fn snake(name: &str) -> String {
    let slug = package(name).replace(['-', '.'], "_");
    if slug.starts_with(|c: char| c.is_ascii_digit()) {
        format!("app_{slug}")
    } else {
        slug
    }
}

fn fill(text: &str, name: &str) -> String {
    text.replace("{{title}}", &title(name))
        .replace("{{package}}", &package(name))
        .replace("{{module}}", &snake(name))
}

fn python_install() -> String {
    let venv_python = if cfg!(windows) { ".venv\\Scripts\\python" } else { ".venv/bin/python" };
    let python = if cfg!(windows) { "python" } else { "python3" };
    format!("{python} -m venv .venv && {venv_python} -m pip install -r requirements.txt")
}

/// Works out what creating the project will do, after checking the choice.
pub fn plan(choice: &Choice) -> Result<Plan, String> {
    let spec = spec(&choice.template)?;
    let name = choice.name.trim();
    if let Some(problem) = name_problem(name, spec.name_rule) {
        return Err(problem);
    }

    let parent = PathBuf::from(choice.parent.trim());
    if !parent.is_dir() {
        return Err(format!("{} is not a folder.", parent.display()));
    }
    let folder = parent.join(name);
    if folder.exists() {
        let empty = std::fs::read_dir(&folder).map(|mut entries| entries.next().is_none()).unwrap_or(false);
        // A generator wants to create the folder itself.
        if !empty || spec.generator {
            return Err(format!("{} already exists. Choose another name or location.", folder.display()));
        }
    }

    let install = choice.install && spec.install;
    let mut steps = Vec::new();
    let mut files = Vec::new();

    if spec.generator {
        let command = generator_command(spec.id, name, choice.typescript, install)
            .ok_or_else(|| format!("{} has no generator.", spec.name))?;
        steps.push(Step { title: format!("Creating the project with {}", spec.name), command, in_project: false });
        // create-vite never installs; the others did it themselves.
        if install && spec.id.starts_with("vite-") {
            steps.push(Step { title: "Installing dependencies".into(), command: "npm install".into(), in_project: true });
        }
    } else {
        for (template, path, content) in FILES.iter().filter(|(template, _, _)| *template == spec.id) {
            let _ = template;
            // Paths hold placeholders too (src/main/java/{{module}}/App.java).
            files.push((fill(path, name), fill(content, name)));
        }

        if install {
            match spec.id {
                "express" => steps.push(Step { title: "Installing dependencies".into(), command: "npm install".into(), in_project: true }),
                "flask" | "fastapi" => steps.push(Step {
                    title: "Creating a virtual environment and installing packages".into(),
                    command: python_install(),
                    in_project: true,
                }),
                _ => {}
            }
        }
    }

    Ok(Plan { template: spec.id, folder, files, steps, git: choice.git })
}

/// Writes a built-in template's files into the (new) project folder.
pub fn write_files(plan: &Plan) -> Result<(), String> {
    std::fs::create_dir_all(&plan.folder)
        .map_err(|error| format!("The project folder could not be created: {error}"))?;
    for (path, content) in &plan.files {
        let target = plan.folder.join(path);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
        }
        std::fs::write(&target, content).map_err(|error| format!("Could not write {path}: {error}"))?;
    }
    Ok(())
}

/// Gradle to run `gradle wrapper` with: the one on PATH, else the newest
/// distribution the wrapper of another project already downloaded
/// (`~/.gradle/wrapper/dists`), so no Gradle install is needed.
pub fn find_gradle() -> Option<(String, Option<String>)> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if find_tool("gradle", &dirs).is_some() {
        return Some(("gradle".into(), None));
    }

    let home = std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|home| PathBuf::from(home).join(".gradle"))
    })?;
    let mut found: Vec<(Vec<u32>, PathBuf, String)> = Vec::new();
    for dist in std::fs::read_dir(home.join("wrapper").join("dists")).ok()?.flatten() {
        // gradle-9.8.2-bin/<hash>/gradle-9.8.2/bin/gradle(.bat)
        for hashed in std::fs::read_dir(dist.path()).into_iter().flatten().flatten() {
            for unpacked in std::fs::read_dir(hashed.path()).into_iter().flatten().flatten() {
                let folder = unpacked.file_name().to_string_lossy().into_owned();
                let Some(version) = folder.strip_prefix("gradle-") else { continue };
                let launcher = unpacked.path().join("bin").join(if cfg!(windows) { "gradle.bat" } else { "gradle" });
                if !launcher.is_file() {
                    continue;
                }
                let parts: Vec<u32> = version.split(['.', '-']).map_while(|part| part.parse().ok()).collect();
                if !parts.is_empty() {
                    found.push((parts, launcher, version.to_string()));
                }
            }
        }
    }
    found.sort();
    let (_, launcher, version) = found.pop()?;
    Some((format!("\"{}\"", launcher.display()), Some(version)))
}

/// Adds the Gradle wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/`) to
/// a new Gradle project, so it builds without Gradle installed. `gradle
/// wrapper` runs in an empty project, so the new build's plugins need not be
/// downloaded first; pinned to a cached version, nothing is downloaded at all.
pub async fn add_gradle_wrapper(
    folder: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    on_output: &mut (dyn FnMut(&str) + Send),
) -> Result<(), String> {
    let Some((gradle, version)) = find_gradle() else {
        on_output("Gradle was not found (not on PATH, and no distribution in ~/.gradle/wrapper/dists), so the project has no wrapper yet. Install Gradle and run: gradle wrapper\n");
        return Ok(());
    };

    let scratch = std::env::temp_dir().join(format!("nexium-gradle-wrapper-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|error| format!("Could not prepare the wrapper: {error}"))?;
    std::fs::write(scratch.join("settings.gradle.kts"), "rootProject.name = \"wrapper\"\n")
        .map_err(|error| format!("Could not prepare the wrapper: {error}"))?;

    let command = match &version {
        Some(version) => format!("{gradle} wrapper --gradle-version {version} --no-daemon --offline"),
        None => format!("{gradle} wrapper --no-daemon"),
    };
    on_output(&format!("$ {command}\n"));
    let outcome = crate::command::run_streaming(&scratch, &command, std::time::Duration::from_secs(600), cancel, on_output).await?;
    if outcome.exit_code != Some(0) {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err(format!("Adding the Gradle wrapper failed (exit code {}).", outcome.exit_code.map_or("none".into(), |code| code.to_string())));
    }

    for file in ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"] {
        let from = scratch.join(file);
        let to = folder.join(file);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
        }
        std::fs::copy(&from, &to).map_err(|error| format!("Could not copy {file}: {error}"))?;
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// Fills gaps a generator leaves: `cargo new --vcs none` writes no
/// .gitignore, so a new repository would otherwise commit `target/`.
pub fn finish(plan: &Plan) -> Result<(), String> {
    let ignore = plan.folder.join(".gitignore");
    if plan.template == "rust" && !ignore.exists() {
        std::fs::write(&ignore, "/target\n").map_err(|error| format!("Could not write .gitignore: {error}"))?;
    }
    Ok(())
}

/// Which developer tools are on PATH, by name. Looks at PATH directly
/// (no processes started), so it is instant.
pub fn installed_tools() -> BTreeMap<&'static str, bool> {
    const TOOLS: [&str; 13] = [
        "node", "npm", "npx", "git", "python", "cargo", "go", "flutter", "dotnet", "java", "gradle", "cmake", "deno",
    ];
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    TOOLS.iter().map(|tool| (*tool, find_tool(tool, &dirs).is_some())).collect()
}

fn find_tool(tool: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    // python3 is the usual name outside Windows.
    let stems: Vec<&str> = if tool == "python" && !cfg!(windows) { vec!["python3", "python"] } else { vec![tool] };
    let names: Vec<String> = if cfg!(windows) {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        exts.split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| format!("{tool}{}", ext.to_ascii_lowercase()))
            .collect()
    } else {
        stems.iter().map(|stem| stem.to_string()).collect()
    };

    for dir in dirs {
        // The Microsoft Store's python.exe stub only opens the Store.
        if tool == "python" && dir.to_string_lossy().to_ascii_lowercase().contains("windowsapps") {
            continue;
        }
        for name in &names {
            let path = dir.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// A tool this template needs that is missing, if any.
pub fn missing_tool(id: &str, tools: &BTreeMap<&'static str, bool>) -> Option<&'static str> {
    let spec = spec(id).ok()?;
    spec.requires.iter().copied().find(|tool| !tools.get(tool).copied().unwrap_or(false))
}

/// Where a step runs.
pub fn step_folder(plan: &Plan, step: &Step) -> PathBuf {
    if step.in_project {
        plan.folder.clone()
    } else {
        plan.folder.parent().map(Path::to_path_buf).unwrap_or_else(|| plan.folder.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(template: &str, parent: &Path, name: &str) -> Choice {
        Choice {
            template: template.into(),
            parent: parent.to_string_lossy().into(),
            name: name.into(),
            typescript: true,
            install: false,
            git: false,
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexium-templates-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_template_is_complete() {
        let ids: Vec<&str> = SPECS.iter().map(|spec| spec.id).collect();
        for (template, path, _) in FILES {
            assert!(ids.contains(template), "{path} belongs to no template");
        }
        for spec in SPECS {
            if spec.generator {
                assert!(generator_command(spec.id, "my-app", true, true).is_some(), "{}", spec.id);
            } else if spec.id != "blank" {
                assert!(FILES.iter().any(|(t, _, _)| *t == spec.id), "{} has no files", spec.id);
            }
        }
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());
    }

    #[test]
    fn names_follow_the_rules() {
        assert!(name_problem("My Site", NameRule::Folder).is_none());
        assert!(name_problem("", NameRule::Folder).is_some());
        assert!(name_problem("a/b", NameRule::Folder).is_some());
        assert!(name_problem("con", NameRule::Folder).is_some());
        assert!(name_problem("COM1.txt", NameRule::Folder).is_some());
        assert!(name_problem("communicator", NameRule::Folder).is_none());
        assert!(name_problem("my-app", NameRule::Package).is_none());
        assert!(name_problem("My App", NameRule::Package).is_some());
        assert!(name_problem("my_app", NameRule::Snake).is_none());
        assert!(name_problem("my-app", NameRule::Snake).is_some());
        assert!(name_problem("1app", NameRule::Snake).is_some());

        assert_eq!(title("nexium-studio"), "Nexium Studio");
        assert_eq!(package("Nexium Studio!"), "nexium-studio");
        assert_eq!(snake("Nexium Studio"), "nexium_studio");
        assert_eq!(snake("3d viewer"), "app_3d_viewer");
    }

    #[test]
    fn builds_a_builtin_project() {
        let parent = scratch("builtin");
        let plan = plan(&choice("bootstrap", &parent, "Nexium Studio")).unwrap();
        assert!(plan.steps.is_empty());
        write_files(&plan).unwrap();

        let page = std::fs::read_to_string(parent.join("Nexium Studio/index.html")).unwrap();
        assert!(page.contains("<title>Nexium Studio</title>"));
        assert!(!page.contains("{{"));
        assert!(parent.join("Nexium Studio/.gitignore").is_file(), "dotfiles are restored");

        // The folder now exists and is not empty.
        assert!(super::plan(&choice("bootstrap", &parent, "Nexium Studio")).unwrap_err().contains("already exists"));

        // Flask keeps its own Jinja placeholders.
        let flask = super::plan(&choice("flask", &parent, "web")).unwrap();
        let index = flask.files.iter().find(|(path, _)| path == "templates/index.html").unwrap();
        assert!(index.1.contains("{{ title }}"));
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn plans_generators() {
        let parent = scratch("generator");
        let mut react = choice("vite-react", &parent, "my-app");
        react.install = true;
        let plan = plan(&react).unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert!(plan.steps[0].command.contains("--template react-ts"));
        assert!(!plan.steps[0].in_project);
        assert_eq!(plan.steps[1].command, "npm install");
        assert!(plan.steps[1].in_project);
        assert_eq!(step_folder(&plan, &plan.steps[0]), parent);

        react.typescript = false;
        react.install = false;
        let js = super::plan(&react).unwrap();
        assert!(js.steps[0].command.contains("--template react --"));
        assert_eq!(js.steps.len(), 1);

        assert!(super::plan(&choice("vite-react", &parent, "My App")).unwrap_err().contains("lowercase"));
        assert!(super::plan(&choice("flutter", &parent, "my_app")).unwrap().steps[0].command.ends_with("--no-pub"));

        // Gradle projects are written by the app, then get a wrapper.
        let java = super::plan(&choice("java-gradle", &parent, "hello-java")).unwrap();
        assert!(java.files.iter().any(|(path, content)| path == "src/main/java/hello_java/App.java"
            && content.starts_with("package hello_java;")));
        assert!(java.steps.is_empty(), "the wrapper is added after the files, not by a shell step");
        let kotlin = super::plan(&choice("kotlin-gradle", &parent, "hello-kt")).unwrap();
        assert!(kotlin.files.iter().any(|(path, _)| path == "src/test/kotlin/hello_kt/AppTest.kt"));
        assert!(kotlin.files.iter().all(|(path, content)| !path.contains("{{") && !content.contains("{{")));

        // After `cargo new --vcs none`, a .gitignore keeps target/ out of git.
        let rust = super::plan(&choice("rust", &parent, "tool")).unwrap();
        std::fs::create_dir_all(&rust.folder).unwrap();
        finish(&rust).unwrap();
        assert_eq!(std::fs::read_to_string(rust.folder.join(".gitignore")).unwrap(), "/target\n");
        assert!(super::plan(&choice("nope", &parent, "x")).is_err());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn finds_tools_on_path() {
        let tools = installed_tools();
        assert!(tools.contains_key("node"));
        let dirs = vec![std::env::temp_dir()];
        assert!(find_tool("definitely-not-a-tool", &dirs).is_none());
        let missing: BTreeMap<&'static str, bool> = [("npm", false)].into_iter().collect();
        assert_eq!(missing_tool("vite-react", &missing), Some("npm"));
        assert_eq!(missing_tool("bootstrap", &missing), None);
    }
}
