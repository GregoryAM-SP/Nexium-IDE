//! GitHub: the account the user is signed in with, creating repositories, and
//! the credentials git uses for github.com over HTTPS.
//!
//! Sign-in is a token saved in the OS credential store (Settings → Source
//! control), or, when none is saved, the GitHub CLI's login (`gh auth token`).
//! The token never appears on a command line: git gets it through
//! `GIT_CONFIG_*` environment variables as an HTTP header for github.com only.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

use crate::secrets;

pub const API: &str = "https://api.github.com";

pub struct Credentials {
    pub token: String,
    /// `token` (saved in Nexium) or `cli` (the GitHub CLI's login).
    pub source: &'static str,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub source: String,
    /// Where a repository can be created: the user, then their organisations.
    pub owners: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepo {
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
    pub private: bool,
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The GitHub CLI's token, if it is installed and signed in.
fn cli_token() -> Option<String> {
    let output = hidden(Command::new("gh").args(["auth", "token", "--hostname", "github.com"]))
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|token| !token.is_empty())
}

/// The saved token, else the GitHub CLI's.
pub fn credentials() -> Option<Credentials> {
    if let Ok(Some(token)) = secrets::github_token() {
        if !token.trim().is_empty() {
            return Some(Credentials { token, source: "token" });
        }
    }

    cli_token().map(|token| Credentials { token, source: "cli" })
}

/// Lets git authenticate to github.com with the token for one command. The
/// header is scoped to `https://github.com/`, so no other host ever sees it.
pub fn git_env(token: &str) -> Vec<(String, String)> {
    let basic = BASE64.encode(format!("x-access-token:{token}"));
    vec![
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        ("GIT_CONFIG_KEY_0".into(), "http.https://github.com/.extraheader".into()),
        ("GIT_CONFIG_VALUE_0".into(), format!("AUTHORIZATION: basic {basic}")),
    ]
}

/// The credentials for a repository's network commands: only when one of its
/// remotes is on github.com over HTTPS and a sign-in exists.
pub fn auth_for(root: &Path) -> Vec<(String, String)> {
    let remotes = hidden(Command::new("git").arg("-C").arg(root).args(["remote", "-v"]))
        .stdin(Stdio::null())
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();

    if !remotes.contains("https://github.com/") {
        return Vec::new();
    }

    credentials().map(|credentials| git_env(&credentials.token)).unwrap_or_default()
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }

    let built = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .user_agent("Nexium-Studio")
        .build()
        .map_err(|error| format!("Could not prepare a connection to GitHub: {error}"))?;

    Ok(CLIENT.get_or_init(|| built))
}

fn api_message(body: &Value) -> String {
    let message = body.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let details: Vec<String> = body
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| error.as_str().map(str::to_string))
                })
                .collect()
        })
        .unwrap_or_default();

    if details.is_empty() {
        message
    } else {
        format!("{message}: {}", details.join("; "))
    }
}

async fn request(
    api: &str,
    token: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let mut builder = client()?
        .request(method, format!("{api}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");

    if let Some(body) = body {
        builder = builder.json(&body);
    }

    let response = builder.send().await.map_err(|error| {
        if error.is_timeout() {
            "GitHub did not answer in time. Check your connection and try again.".to_string()
        } else {
            format!("Could not reach GitHub: {error}")
        }
    })?;

    let status = response.status().as_u16();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);

    if status == 401 {
        return Err("GitHub did not accept the token: it may have expired or been revoked. Sign in again in Settings → Source control.".into());
    }

    Ok((status, value))
}

/// Who the token belongs to, and the organisations they can create in.
pub async fn account(api: &str, token: &str, source: &str) -> Result<Account, String> {
    let (status, user) = request(api, token, reqwest::Method::GET, "/user", None).await?;

    if status != 200 {
        return Err(format!("GitHub refused to say who is signed in ({status}): {}", api_message(&user)));
    }

    let login = user.get("login").and_then(Value::as_str).unwrap_or("").to_string();
    if login.is_empty() {
        return Err("GitHub's answer had no account name.".into());
    }

    // Organisations need the read:org scope; without it only the user is listed.
    let mut owners = vec![login.clone()];
    if let Ok((200, orgs)) = request(api, token, reqwest::Method::GET, "/user/orgs?per_page=100", None).await {
        owners.extend(
            orgs.as_array()
                .into_iter()
                .flatten()
                .filter_map(|org| org.get("login").and_then(Value::as_str).map(str::to_string)),
        );
    }

    Ok(Account {
        login,
        name: user.get("name").and_then(Value::as_str).map(str::to_string).filter(|name| !name.is_empty()),
        avatar_url: user.get("avatar_url").and_then(Value::as_str).unwrap_or("").to_string(),
        source: source.to_string(),
        owners,
    })
}

/// GitHub's rule for repository names: letters, digits, `.`, `-` and `_`.
pub fn check_repo_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Enter a repository name.".into());
    }
    if name.len() > 100 {
        return Err("A repository name can be at most 100 characters.".into());
    }
    if name == "." || name == ".." {
        return Err("That repository name is reserved.".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("A repository name can only use letters, digits, \".\", \"-\" and \"_\".".into());
    }
    Ok(())
}

/// A name GitHub would accept, made from a folder name: other characters
/// become `-`, as GitHub itself does.
pub fn suggest_repo_name(folder: &str) -> String {
    let mut name: String = folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
        .collect();
    while name.contains("--") {
        name = name.replace("--", "-");
    }
    let name = name.trim_matches('-').to_string();
    if name.is_empty() || name == "." || name == ".." {
        "my-project".into()
    } else {
        name.chars().take(100).collect()
    }
}

/// Creates an empty repository (no README, so the first push is not
/// rejected) under the user or one of their organisations.
pub async fn create_repo(
    api: &str,
    token: &str,
    login: &str,
    owner: &str,
    name: &str,
    description: &str,
    private: bool,
) -> Result<CreatedRepo, String> {
    check_repo_name(name)?;

    let path = if owner.is_empty() || owner.eq_ignore_ascii_case(login) {
        "/user/repos".to_string()
    } else {
        format!("/orgs/{owner}/repos")
    };
    let owner_label = if owner.is_empty() { login } else { owner };

    let (status, body) = request(
        api,
        token,
        reqwest::Method::POST,
        &path,
        Some(json!({
            "name": name,
            "description": description.trim(),
            "private": private,
            "auto_init": false,
        })),
    )
    .await?;

    match status {
        201 => Ok(CreatedRepo {
            full_name: body.get("full_name").and_then(Value::as_str).unwrap_or("").to_string(),
            html_url: body.get("html_url").and_then(Value::as_str).unwrap_or("").to_string(),
            clone_url: body.get("clone_url").and_then(Value::as_str).unwrap_or("").to_string(),
            private: body.get("private").and_then(Value::as_bool).unwrap_or(private),
        }),
        422 if api_message(&body).to_lowercase().contains("already exists") => Err(format!(
            "A repository named {owner_label}/{name} already exists on GitHub. Choose another name."
        )),
        403 | 404 => Err(format!(
            "GitHub would not create a repository in {owner_label} ({status}): {}. The token needs the \"repo\" scope (or \"public_repo\" for public repositories), and permission to create repositories there.",
            api_message(&body)
        )),
        _ => Err(format!("GitHub could not create the repository ({status}): {}", api_message(&body))),
    }
}

/// Opens a github.com page (a new repository, the token page) in the
/// browser. Nothing else can be opened this way.
pub fn open_page(url: &str) -> Result<(), String> {
    let allowed = url.starts_with("https://github.com/")
        && url.len() < 500
        && url.chars().all(|c| c.is_ascii_alphanumeric() || "/:._-?=&,+%#~".contains(c));

    if !allowed {
        return Err("Only github.com pages can be opened.".into());
    }

    #[cfg(windows)]
    let result = hidden(Command::new("rundll32").args(["url.dll,FileProtocolHandler", url])).spawn();

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
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A one-file stand-in for api.github.com: answers each request from the
    /// script in order and records what it was asked.
    fn fake_github(script: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in script {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                    if read == 0 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&request).to_string());
                let payload = body.to_string();
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
            seen
        });
        (address, handle)
    }

    fn block<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn reads_the_account_and_its_organisations() {
        let (api, server) = fake_github(vec![
            (200, json!({ "login": "octo", "name": "Octo Cat", "avatar_url": "https://a/1" })),
            (200, json!([{ "login": "acme" }, { "login": "tools" }])),
        ]);
        let account = block(account(&api, "secret-token", "token")).unwrap();
        assert_eq!(account.login, "octo");
        assert_eq!(account.owners, vec!["octo", "acme", "tools"]);
        let seen = server.join().unwrap();
        assert!(seen[0].starts_with("GET /user "));
        assert!(seen[0].to_lowercase().contains("authorization: bearer secret-token"));
        assert!(seen[1].starts_with("GET /user/orgs"));
    }

    #[test]
    fn creates_private_and_organisation_repositories() {
        let (api, server) = fake_github(vec![
            (201, json!({ "full_name": "octo/demo", "html_url": "https://github.com/octo/demo", "clone_url": "https://github.com/octo/demo.git", "private": true })),
            (201, json!({ "full_name": "acme/site", "html_url": "https://github.com/acme/site", "clone_url": "https://github.com/acme/site.git", "private": false })),
        ]);
        let mine = block(create_repo(&api, "t", "octo", "octo", "demo", "A demo", true)).unwrap();
        assert_eq!(mine.clone_url, "https://github.com/octo/demo.git");
        assert!(mine.private);
        let org = block(create_repo(&api, "t", "octo", "acme", "site", "", false)).unwrap();
        assert_eq!(org.full_name, "acme/site");

        let seen = server.join().unwrap();
        assert!(seen[0].starts_with("POST /user/repos "));
        assert!(seen[0].contains("\"private\":true") && seen[0].contains("\"auto_init\":false"));
        assert!(seen[1].starts_with("POST /orgs/acme/repos "));
        assert!(seen[1].contains("\"private\":false"));
    }

    #[test]
    fn explains_github_refusals() {
        let (api, server) = fake_github(vec![
            (422, json!({ "message": "Repository creation failed.", "errors": [{ "message": "name already exists on this account" }] })),
            (401, json!({ "message": "Bad credentials" })),
            (403, json!({ "message": "Resource not accessible by personal access token" })),
        ]);
        let taken = block(create_repo(&api, "t", "octo", "octo", "demo", "", true)).unwrap_err();
        assert!(taken.contains("octo/demo already exists"), "{taken}");
        let expired = block(create_repo(&api, "t", "octo", "octo", "demo", "", true)).unwrap_err();
        assert!(expired.contains("did not accept the token"));
        let scope = block(create_repo(&api, "t", "octo", "acme", "demo", "", true)).unwrap_err();
        assert!(scope.contains("\"repo\" scope"));
        server.join().unwrap();

        assert!(block(create_repo("http://127.0.0.1:9", "t", "o", "o", "bad name", "", true)).unwrap_err().contains("only use letters"));
    }

    #[test]
    fn opens_only_github_pages() {
        assert!(open_page("https://evil.example/x").is_err());
        assert!(open_page("https://github.com.evil.example/x").is_err());
        assert!(open_page("https://github.com/x\" & calc").is_err());
        assert!(open_page("file:///C:/Windows").is_err());
    }

    #[test]
    fn repository_names_follow_github_rules() {
        assert!(check_repo_name("nexium-studio").is_ok());
        assert!(check_repo_name("my.site_v2").is_ok());
        assert!(check_repo_name("").is_err());
        assert!(check_repo_name("..").is_err());
        assert!(check_repo_name("has space").is_err());
        assert_eq!(suggest_repo_name("My Project (v2)"), "My-Project-v2");
        assert_eq!(suggest_repo_name("***"), "my-project");
        assert_eq!(suggest_repo_name("Nexium-IDE"), "Nexium-IDE");
    }

    #[test]
    fn git_gets_the_token_as_a_header_for_github_only() {
        let env = git_env("abc");
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".to_string(), "1".to_string()));
        assert_eq!(env[1].1, "http.https://github.com/.extraheader");
        assert_eq!(env[2].1, format!("AUTHORIZATION: basic {}", BASE64.encode("x-access-token:abc")));
        assert!(!env.iter().any(|(_, value)| value.contains("abc") && !value.starts_with("AUTHORIZATION")));
    }
}
