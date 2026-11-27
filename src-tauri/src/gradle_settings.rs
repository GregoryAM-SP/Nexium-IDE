//! Reading and editing a Gradle build's configuration: the JDK and SDK
//! versions in each module's build script, `gradle.properties`, the Android
//! SDK path in `local.properties`, and the wrapper's Gradle version.
//!
//! Every edit is a small, targeted text change so the rest of each file is
//! left exactly as the user wrote it.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::gradle;

const GRADLE_PROPERTIES: &str = "gradle.properties";
const LOCAL_PROPERTIES: &str = "local.properties";
const WRAPPER_PROPERTIES: &str = "gradle/wrapper/gradle-wrapper.properties";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdkInstall {
    pub path: String,
    /// The full version from the JDK's `release` file, e.g. `17.0.10`.
    pub version: String,
    pub major: u32,
    pub vendor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidSdk {
    pub path: String,
    /// Installed platform API levels, newest first.
    pub platforms: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSettings {
    pub path: String,
    pub name: String,
    pub build_file: String,
    pub android: bool,
    pub kotlin: bool,
    /// `JavaLanguageVersion.of(N)` or `jvmToolchain(N)`.
    pub toolchain: Option<String>,
    pub source_compatibility: Option<String>,
    pub target_compatibility: Option<String>,
    pub compile_sdk: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradleSettings {
    pub wrapper_version: Option<String>,
    /// Every entry in `gradle.properties`, unescaped.
    pub properties: BTreeMap<String, String>,
    pub android_sdk_dir: Option<String>,
    pub modules: Vec<ModuleSettings>,
    pub jdks: Vec<JdkInstall>,
    pub android_sdks: Vec<AndroidSdk>,
}

/// One change to make. `value: None` removes a property.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingEdit {
    /// "gradle.properties", "local.properties", "wrapper" or "module".
    pub target: String,
    /// The Gradle project path for `module` edits, e.g. `:app`.
    pub project: Option<String>,
    pub key: String,
    pub value: Option<String>,
}

// ---------------------------------------------------------------------------
// .properties files

/// Splits a file into logical lines: a line ending in an odd number of
/// backslashes continues on the next one.
fn logical_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();

    for line in text.lines() {
        current.push_str(line);
        let trailing = line.chars().rev().take_while(|ch| *ch == '\\').count();

        if trailing % 2 == 1 {
            current.push('\n');
            continue;
        }

        lines.push(std::mem::take(&mut current));
    }

    if !current.is_empty() {
        lines.push(current);
    }

    lines
}

/// The key and raw (still escaped) value of a property line.
fn split_property(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();

    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
        return None;
    }

    let mut key = String::new();
    let mut chars = trimmed.char_indices().peekable();
    let mut rest_at = trimmed.len();

    while let Some((index, ch)) = chars.next() {
        match ch {
            '\\' => {
                if let Some((_, next)) = chars.next() {
                    key.push(next);
                }
            }
            '=' | ':' | ' ' | '\t' => {
                rest_at = index;
                break;
            }
            _ => key.push(ch),
        }
    }

    let rest = trimmed[rest_at..].trim_start();
    let rest = rest
        .strip_prefix('=')
        .or_else(|| rest.strip_prefix(':'))
        .unwrap_or(rest)
        .trim_start();

    Some((key, rest.to_string()))
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }

        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            // A continuation: the newline and the next line's indent go.
            Some('\n') => {
                while chars.clone().next().is_some_and(char::is_whitespace) {
                    chars.next();
                }
            }
            Some(next) => out.push(next),
            None => {}
        }
    }

    out
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\")
}

pub fn read_properties(text: &str) -> BTreeMap<String, String> {
    logical_lines(text)
        .iter()
        .filter_map(|line| split_property(line))
        .map(|(key, value)| (key, unescape(&value)))
        .collect()
}

/// Sets, replaces or (with `None`) removes one property, keeping every other
/// line and comment in place.
pub fn set_property(text: &str, key: &str, value: Option<&str>) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines = Vec::new();
    let mut done = false;

    for line in logical_lines(text) {
        let matches = split_property(&line).is_some_and(|(found, _)| found == key);

        if !matches {
            lines.push(line.replace('\n', newline));
            continue;
        }

        if let (Some(value), false) = (value, done) {
            lines.push(format!("{key}={}", escape(value)));
        }

        done = true;
    }

    if let (Some(value), false) = (value, done) {
        lines.push(format!("{key}={}", escape(value)));
    }

    let mut out = lines.join(newline);

    if !out.is_empty() {
        out.push_str(newline);
    }

    out
}

// ---------------------------------------------------------------------------
// Gradle wrapper

fn wrapper_version_from_url(url: &str) -> Option<String> {
    let file = url.rsplit('/').next()?;
    let version = file.strip_prefix("gradle-")?;
    let version = version
        .strip_suffix("-bin.zip")
        .or_else(|| version.strip_suffix("-all.zip"))?;

    Some(version.to_string())
}

fn valid_gradle_version(version: &str) -> bool {
    let mut parts = version.splitn(2, '-');
    let numbers = parts.next().unwrap_or("");
    let suffix_ok = parts.next().map_or(true, |suffix| {
        suffix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    });

    let segments: Vec<&str> = numbers.split('.').collect();

    (2..=3).contains(&segments.len())
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()))
        && suffix_ok
}

fn set_wrapper_version(text: &str, version: &str) -> Result<String, String> {
    if !valid_gradle_version(version) {
        return Err(format!("\"{version}\" is not a Gradle version, e.g. 8.10.2."));
    }

    let url = read_properties(text)
        .get("distributionUrl")
        .cloned()
        .ok_or("The wrapper has no distributionUrl to change.")?;

    let (base, file) = url
        .rsplit_once('/')
        .ok_or("The wrapper's distributionUrl is not a Gradle download link.")?;
    let flavour = if file.ends_with("-all.zip") { "all" } else { "bin" };
    let next = format!("{base}/gradle-{version}-{flavour}.zip");

    let updated = set_property(text, "distributionUrl", Some(&next));

    // The checksum belongs to the old download and would fail the new one.
    Ok(set_property(&updated, "distributionSha256Sum", None))
}

// ---------------------------------------------------------------------------
// Build scripts

/// The byte range of the value in `key = value`, `key value` or `key(value)`
/// statements, one per matching line. Commented lines are skipped.
fn find_assignments(script: &str, keys: &[&str]) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut offset = 0;

    for line in script.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();

        let content = line.trim_end_matches(['\n', '\r']);
        let indent = content.len() - content.trim_start().len();
        let trimmed = &content[indent..];

        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }

        for key in keys {
            let after_prefix = ["", "java.", "android.", "kotlin."]
                .iter()
                .find_map(|prefix| trimmed.strip_prefix(prefix)?.strip_prefix(key));

            let Some(rest) = after_prefix else {
                continue;
            };

            let Some(first) = rest.chars().next() else {
                continue;
            };

            if !matches!(first, ' ' | '\t' | '=' | '(') {
                continue;
            }

            let rest_start = line_start + indent + (trimmed.len() - rest.len());
            let lead = rest.len() - rest.trim_start().len();
            let mut value = &rest[lead..];
            let mut value_start = rest_start + lead;

            if let Some(stripped) = value.strip_prefix('=') {
                let skip = 1 + (stripped.len() - stripped.trim_start().len());
                value = &value[skip..];
                value_start += skip;
            }

            let end = if let Some(inner) = value.strip_prefix('(') {
                value_start += 1;
                inner.rfind(')').unwrap_or(inner.len())
            } else {
                let without_comment = value.find("//").unwrap_or(value.len());
                value[..without_comment].trim_end().len()
            };

            if end > 0 {
                found.push((value_start, value_start + end));
            }

            break;
        }
    }

    found
}

/// The value inside the parentheses after each `marker`, e.g. the `17` in
/// `JavaLanguageVersion.of(17)`.
fn find_calls(script: &str, markers: &[&str]) -> Vec<(usize, usize)> {
    let mut found = Vec::new();

    for marker in markers {
        let mut from = 0;

        while let Some(position) = script[from..].find(marker) {
            let start = from + position + marker.len();

            if let Some(close) = script[start..].find(')') {
                if !script[start..start + close].contains('\n') {
                    found.push((start, start + close));
                }
            }

            from = start;
        }
    }

    found.sort();
    found
}

fn strip_quotes(value: &str) -> &str {
    value.trim().trim_matches(['"', '\''])
}

/// `JavaVersion.VERSION_1_8` → `1.8`, `'17'` → `17`; anything else as written.
fn normalise_java_version(raw: &str) -> String {
    let value = strip_quotes(raw);

    if let Some(version) = value.strip_prefix("JavaVersion.VERSION_") {
        return version.replace('_', ".");
    }

    if let Some(inner) = value
        .strip_prefix("JavaVersion.toVersion(")
        .and_then(|inner| inner.strip_suffix(')'))
    {
        return strip_quotes(inner).to_string();
    }

    value.to_string()
}

fn first_value(script: &str, ranges: &[(usize, usize)]) -> Option<String> {
    ranges
        .first()
        .map(|(start, end)| script[*start..*end].trim().to_string())
}

fn replace_ranges(script: &str, ranges: &[(usize, usize)], value: &str) -> String {
    let mut out = script.to_string();

    for (start, end) in ranges.iter().rev() {
        out.replace_range(*start..*end, value);
    }

    out
}

const TOOLCHAIN_CALLS: [&str; 2] = ["JavaLanguageVersion.of(", "jvmToolchain("];
const SOURCE_KEYS: [&str; 1] = ["sourceCompatibility"];
const TARGET_KEYS: [&str; 1] = ["targetCompatibility"];
const COMPILE_SDK_KEYS: [&str; 2] = ["compileSdk", "compileSdkVersion"];
const MIN_SDK_KEYS: [&str; 2] = ["minSdk", "minSdkVersion"];
const TARGET_SDK_KEYS: [&str; 2] = ["targetSdk", "targetSdkVersion"];

fn sdk_keys(key: &str) -> Option<&'static [&'static str]> {
    match key {
        "compileSdk" => Some(&COMPILE_SDK_KEYS),
        "minSdk" => Some(&MIN_SDK_KEYS),
        "targetSdk" => Some(&TARGET_SDK_KEYS),
        _ => None,
    }
}

fn module_settings(root: &Path, project: &gradle::GradleProject) -> Option<ModuleSettings> {
    let build_file = project.build_file.clone()?;
    let script = fs::read_to_string(root.join(&build_file)).ok()?;

    let toolchain = first_value(&script, &find_calls(&script, &TOOLCHAIN_CALLS))
        .map(|value| strip_quotes(&value).to_string());
    let compat = |keys: &[&str]| {
        first_value(&script, &find_assignments(&script, keys)).map(|raw| normalise_java_version(&raw))
    };
    let sdk = |keys: &[&str]| first_value(&script, &find_assignments(&script, keys));

    Some(ModuleSettings {
        path: project.path.clone(),
        name: project.name.clone(),
        build_file,
        android: project.plugins.iter().any(|plugin| plugin.starts_with("Android")),
        kotlin: script.contains("kotlin"),
        toolchain,
        source_compatibility: compat(&SOURCE_KEYS),
        target_compatibility: compat(&TARGET_KEYS),
        compile_sdk: sdk(&COMPILE_SDK_KEYS),
        min_sdk: sdk(&MIN_SDK_KEYS),
        target_sdk: sdk(&TARGET_SDK_KEYS),
    })
}

fn is_whole_number(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn edit_build_script(script: &str, key: &str, value: &str) -> Result<String, String> {
    let value = value.trim();

    if value.is_empty() || value.contains('\n') {
        return Err(format!("Enter a value for {key}."));
    }

    match key {
        "toolchain" => {
            if !is_whole_number(value) {
                return Err("The Java toolchain is a whole version number, e.g. 17.".into());
            }

            let calls = find_calls(script, &TOOLCHAIN_CALLS);

            if !calls.is_empty() {
                return Ok(replace_ranges(script, &calls, value));
            }

            // No toolchain yet: add the block the module's language expects.
            let block = if script.contains("kotlin") {
                format!("kotlin {{\n    jvmToolchain({value})\n}}\n")
            } else {
                format!(
                    "java {{\n    toolchain {{\n        languageVersion = JavaLanguageVersion.of({value})\n    }}\n}}\n"
                )
            };
            let separator = if script.ends_with('\n') || script.is_empty() { "\n" } else { "\n\n" };

            Ok(format!("{script}{separator}{block}"))
        }
        "sourceCompatibility" | "targetCompatibility" => {
            let valid = value.split('.').count() <= 2
                && value.split('.').all(is_whole_number);

            if !valid {
                return Err(format!("{key} is a Java version such as 17 or 1.8."));
            }

            let keys: &[&str] = if key == "sourceCompatibility" { &SOURCE_KEYS } else { &TARGET_KEYS };
            let ranges = find_assignments(script, keys);

            if ranges.is_empty() {
                return Err(format!("{key} is not set in this build script."));
            }

            Ok(replace_ranges(
                script,
                &ranges,
                &format!("JavaVersion.VERSION_{}", value.replace('.', "_")),
            ))
        }
        _ => {
            let keys = sdk_keys(key).ok_or_else(|| format!("\"{key}\" is not a setting Nexium can change."))?;
            let ranges = find_assignments(script, keys);

            if ranges.is_empty() {
                return Err(format!("{key} is not set in this build script."));
            }

            Ok(replace_ranges(script, &ranges, value))
        }
    }
}

// ---------------------------------------------------------------------------
// Installed JDKs and Android SDKs

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn java_binary(home: &Path) -> PathBuf {
    home.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" })
}

fn read_jdk(home: &Path) -> Option<JdkInstall> {
    // macOS bundles keep the real home two levels down.
    let mac_home = home.join("Contents").join("Home");
    let home = if java_binary(&mac_home).is_file() { mac_home } else { home.to_path_buf() };

    if !java_binary(&home).is_file() {
        return None;
    }

    let release = fs::read_to_string(home.join("release")).unwrap_or_default();
    let field = |name: &str| {
        release
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
            .map(|value| value.trim().trim_matches('"').to_string())
    };

    let version = field("JAVA_VERSION").unwrap_or_default();
    let major = {
        let mut parts = version.split(['.', '_', '-', '+']);
        match parts.next().and_then(|part| part.parse::<u32>().ok()) {
            Some(1) => parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
            Some(major) => major,
            None => 0,
        }
    };

    let path = dunce::canonicalize(&home).unwrap_or(home);

    Some(JdkInstall {
        path: path.to_string_lossy().into_owned(),
        version,
        major,
        vendor: field("IMPLEMENTOR").unwrap_or_default(),
    })
}

/// JDKs in the usual install locations, newest first.
pub fn find_jdks() -> Vec<JdkInstall> {
    let mut homes: Vec<PathBuf> = Vec::new();
    let mut parents: Vec<PathBuf> = Vec::new();

    if let Some(java_home) = std::env::var_os("JAVA_HOME") {
        homes.push(PathBuf::from(java_home));
    }

    if let Some(home) = home_dir() {
        parents.push(home.join(".jdks"));
        parents.push(home.join(".gradle").join("jdks"));
        parents.push(home.join(".sdkman").join("candidates").join("java"));
        parents.push(home.join("Library").join("Java").join("JavaVirtualMachines"));
    }

    if cfg!(windows) {
        for base in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            let Some(base) = std::env::var_os(base).map(PathBuf::from) else {
                continue;
            };

            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Eclipse Foundation",
                "Microsoft",
                "Zulu",
                "Amazon Corretto",
                "BellSoft",
                "Semeru",
                "OpenJDK",
            ] {
                parents.push(base.join(vendor));
            }

            homes.push(base.join("Android").join("Android Studio").join("jbr"));
        }
    } else {
        parents.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
        parents.push(PathBuf::from("/usr/lib/jvm"));
        parents.push(PathBuf::from("/usr/java"));
        parents.push(PathBuf::from("/opt/java"));
        homes.push(PathBuf::from("/Applications/Android Studio.app/Contents/jbr"));
    }

    for parent in parents {
        if let Ok(entries) = fs::read_dir(&parent) {
            homes.extend(entries.flatten().map(|entry| entry.path()));
        }
    }

    let mut seen = BTreeSet::new();
    let mut jdks: Vec<JdkInstall> = homes
        .iter()
        .filter_map(|home| read_jdk(home))
        .filter(|jdk| seen.insert(jdk.path.to_lowercase()))
        .collect();

    jdks.sort_by(|left, right| right.major.cmp(&left.major).then(left.path.cmp(&right.path)));
    jdks
}

fn read_android_sdk(path: &Path) -> Option<AndroidSdk> {
    let platforms_dir = path.join("platforms");

    if !platforms_dir.is_dir() && !path.join("platform-tools").is_dir() {
        return None;
    }

    let mut platforms: Vec<u32> = fs::read_dir(&platforms_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .strip_prefix("android-")?
                        .parse()
                        .ok()
                })
                .collect()
        })
        .unwrap_or_default();

    platforms.sort_unstable_by(|left, right| right.cmp(left));

    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());

    Some(AndroidSdk {
        path: path.to_string_lossy().into_owned(),
        platforms,
    })
}

pub fn find_android_sdks(configured: Option<&str>) -> Vec<AndroidSdk> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path) = configured {
        candidates.push(PathBuf::from(path));
    }

    for variable in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(path) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(path));
        }
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Android").join("Sdk"));
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join("Library").join("Android").join("sdk"));
        candidates.push(home.join("Android").join("Sdk"));
    }

    let mut seen = BTreeSet::new();

    candidates
        .iter()
        .filter_map(|path| read_android_sdk(path))
        .filter(|sdk| seen.insert(sdk.path.to_lowercase()))
        .collect()
}

// ---------------------------------------------------------------------------
// Commands

fn read_text(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap_or_default()
}

pub fn read(root: &Path) -> Result<GradleSettings, String> {
    let info = gradle::detect(root);

    if !info.detected {
        return Err("This folder is not a Gradle build.".into());
    }

    let wrapper_version = read_properties(&read_text(root, WRAPPER_PROPERTIES))
        .get("distributionUrl")
        .and_then(|url| wrapper_version_from_url(url));
    let android_sdk_dir = read_properties(&read_text(root, LOCAL_PROPERTIES))
        .get("sdk.dir")
        .cloned();
    let modules: Vec<ModuleSettings> = info
        .projects
        .iter()
        .filter_map(|project| module_settings(root, project))
        .collect();
    let needs_android = android_sdk_dir.is_some() || modules.iter().any(|module| module.android);

    Ok(GradleSettings {
        wrapper_version,
        properties: read_properties(&read_text(root, GRADLE_PROPERTIES)),
        android_sdks: if needs_android {
            find_android_sdks(android_sdk_dir.as_deref())
        } else {
            Vec::new()
        },
        android_sdk_dir,
        modules,
        jdks: find_jdks(),
    })
}

/// Applies every edit, writing each file once. Returns the files that changed,
/// relative to the workspace root. Nothing is written if any edit is invalid.
pub fn apply(root: &Path, edits: &[SettingEdit]) -> Result<Vec<String>, String> {
    let info = gradle::detect(root);
    let mut files: BTreeMap<String, String> = BTreeMap::new();

    for edit in edits {
        let file = match edit.target.as_str() {
            "gradle.properties" => GRADLE_PROPERTIES.to_string(),
            "local.properties" => LOCAL_PROPERTIES.to_string(),
            "wrapper" => {
                if !root.join(WRAPPER_PROPERTIES).is_file() {
                    return Err("This build has no Gradle wrapper to update.".into());
                }
                WRAPPER_PROPERTIES.to_string()
            }
            "module" => {
                let project = edit.project.as_deref().unwrap_or(":");
                info.projects
                    .iter()
                    .find(|candidate| candidate.path == project)
                    .and_then(|candidate| candidate.build_file.clone())
                    .ok_or_else(|| format!("The project {project} has no build script."))?
            }
            other => return Err(format!("\"{other}\" is not a settings file.")),
        };

        let current = match files.remove(&file) {
            Some(text) => text,
            None => read_text(root, &file),
        };

        let value = edit.value.as_deref().map(str::trim);

        let next = match edit.target.as_str() {
            "wrapper" => set_wrapper_version(&current, value.ok_or("Enter a Gradle version.")?)?,
            "module" => edit_build_script(
                &current,
                &edit.key,
                value.ok_or_else(|| format!("Enter a value for {}.", edit.key))?,
            )?,
            _ => {
                if edit.key.is_empty() || edit.key.contains(['=', ':', '\n', ' ']) {
                    return Err(format!("\"{}\" is not a property name.", edit.key));
                }
                set_property(&current, &edit.key, value.filter(|value| !value.is_empty()))
            }
        };

        files.insert(file, next);
    }

    let mut changed = Vec::new();

    for (file, text) in files {
        if read_text(root, &file) == text {
            continue;
        }

        fs::write(root.join(&file), &text)
            .map_err(|error| format!("{file} could not be saved: {error}"))?;
        changed.push(file);
    }

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Machine-dependent, so only run by hand: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lists_installed_jdks_and_sdks() {
        for jdk in find_jdks() {
            println!("JDK {} {} ({}) at {}", jdk.major, jdk.version, jdk.vendor, jdk.path);
        }
        for sdk in find_android_sdks(None) {
            println!("Android SDK at {} with {:?}", sdk.path, sdk.platforms);
        }
    }

    #[test]
    fn edits_properties_in_place() {
        let text = "# build tuning\norg.gradle.jvmargs=-Xmx2g\norg.gradle.parallel=true\n";

        let set = set_property(text, "org.gradle.parallel", Some("false"));
        assert_eq!(set, "# build tuning\norg.gradle.jvmargs=-Xmx2g\norg.gradle.parallel=false\n");

        let removed = set_property(text, "org.gradle.jvmargs", None);
        assert_eq!(removed, "# build tuning\norg.gradle.parallel=true\n");

        let added = set_property(text, "org.gradle.caching", Some("true"));
        assert!(added.ends_with("org.gradle.caching=true\n"));
    }

    #[test]
    fn round_trips_windows_paths() {
        let text = "sdk.dir=C\\:\\\\Users\\\\me\\\\Android\\\\Sdk\n";
        assert_eq!(read_properties(text)["sdk.dir"], "C:\\Users\\me\\Android\\Sdk");

        let written = set_property("", "sdk.dir", Some("D:\\Sdk"));
        assert_eq!(read_properties(&written)["sdk.dir"], "D:\\Sdk");
    }

    #[test]
    fn changes_the_wrapper_version() {
        let text = "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-all.zip\ndistributionSha256Sum=abc\n";
        assert_eq!(
            wrapper_version_from_url(&read_properties(text)["distributionUrl"]).as_deref(),
            Some("8.5")
        );

        let next = set_wrapper_version(text, "8.10.2").unwrap();
        assert!(next.contains("gradle-8.10.2-all.zip"));
        assert!(!next.contains("distributionSha256Sum"));
        assert!(set_wrapper_version(text, "latest").is_err());
    }

    #[test]
    fn reads_and_edits_android_and_java_settings() {
        let script = "android {\n    compileSdk = 34\n    defaultConfig {\n        minSdkVersion 21 // old\n        targetSdk(34)\n    }\n    compileOptions {\n        sourceCompatibility = JavaVersion.VERSION_1_8\n        targetCompatibility '1.8'\n    }\n}\n";

        assert_eq!(first_value(script, &find_assignments(script, &COMPILE_SDK_KEYS)).as_deref(), Some("34"));
        assert_eq!(first_value(script, &find_assignments(script, &MIN_SDK_KEYS)).as_deref(), Some("21"));
        assert_eq!(first_value(script, &find_assignments(script, &TARGET_SDK_KEYS)).as_deref(), Some("34"));
        assert_eq!(
            normalise_java_version(&first_value(script, &find_assignments(script, &TARGET_KEYS)).unwrap()),
            "1.8"
        );

        let edited = edit_build_script(script, "minSdk", "24").unwrap();
        assert!(edited.contains("minSdkVersion 24 // old"));
        let edited = edit_build_script(&edited, "targetSdk", "35").unwrap();
        assert!(edited.contains("targetSdk(35)"));
        let edited = edit_build_script(&edited, "sourceCompatibility", "17").unwrap();
        assert!(edited.contains("sourceCompatibility = JavaVersion.VERSION_17"));
        assert!(edit_build_script(script, "toolchain", "abc").is_err());
    }

    #[test]
    fn updates_or_adds_a_toolchain() {
        let existing = "java {\n    toolchain {\n        languageVersion = JavaLanguageVersion.of(17)\n    }\n}\n";
        assert_eq!(first_value(existing, &find_calls(existing, &TOOLCHAIN_CALLS)).as_deref(), Some("17"));
        assert!(edit_build_script(existing, "toolchain", "21").unwrap().contains("JavaLanguageVersion.of(21)"));

        let kotlin = "plugins { kotlin(\"jvm\") }\n";
        assert!(edit_build_script(kotlin, "toolchain", "21").unwrap().ends_with("kotlin {\n    jvmToolchain(21)\n}\n"));
    }
}
