//! One client for every OpenAI-compatible chat provider: NVIDIA NIM, Groq,
//! Gemini, OpenRouter, a local Ollama and the rest. Each request names its
//! endpoint (base URL, key, display name), so nothing here is tied to one
//! vendor.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_CONTEXT_CHARS: usize = 24_000;
/// Probing is for a handful of chosen models, never a whole router catalogue.
const MAX_PROBES: usize = 40;

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Where a request goes. The key is empty for providers that need none
/// (local servers, anonymous tiers).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// Display name for error messages, e.g. "Groq".
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

impl Endpoint {
    /// A key may only travel over HTTPS, or plain HTTP to this machine.
    pub fn validate(&self) -> Result<(), String> {
        let trimmed = self.base_url.trim();

        if trimmed.is_empty() {
            return Err(format!("{} has no base URL yet. Add it in Settings.", self.name));
        }

        if trimmed.contains("ACCOUNT_ID") {
            return Err(format!(
                "Replace ACCOUNT_ID in the {} base URL with your account ID.",
                self.name
            ));
        }

        let url = reqwest::Url::parse(trimmed)
            .map_err(|_| format!("The {} base URL is not a valid URL.", self.name))?;
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );

        match url.scheme() {
            "https" => Ok(()),
            "http" if local => Ok(()),
            "http" => Err(format!(
                "The {} base URL must use https:// (plain http is only allowed for localhost).",
                self.name
            )),
            _ => Err(format!("The {} base URL must start with https://.", self.name)),
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url.trim().trim_end_matches('/'), path)
    }

    /// A POST to `path` with the key (when there is one) and the attribution
    /// headers OpenRouter asks apps to send.
    pub fn post(&self, client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
        self.authorize(client.post(self.url(path)))
    }

    fn get(&self, client: &reqwest::Client, path: &str) -> reqwest::RequestBuilder {
        self.authorize(client.get(self.url(path)))
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let key = self.api_key.trim();
        let request = if key.is_empty() {
            request
        } else {
            request.bearer_auth(key)
        };

        if self.base_url.contains("openrouter.ai") {
            request
                .header("HTTP-Referer", "https://github.com/nexium-studio")
                .header("X-Title", "Nexium Studio")
        } else {
            request
        }
    }
}

#[derive(Serialize)]
pub struct Verification {
    /// Fastest first, so the default pick is a model that answers quickly.
    pub working: Vec<String>,
    /// Probe round-trip in milliseconds, keyed by model id.
    pub latency: BTreeMap<String, u64>,
    /// Why each model that did not answer failed, keyed by model id.
    pub failed: BTreeMap<String, String>,
    pub total: usize,
}

#[derive(Serialize, Debug)]
pub struct Ping {
    pub reply: String,
    pub ms: u64,
}

/// A 550B model on a free tier can think for minutes before its first token,
/// so silence is only treated as a dead connection well past that.
pub(crate) const SILENCE_LIMIT: Duration = Duration::from_secs(300);
const TOTAL_LIMIT: Duration = Duration::from_secs(900);

pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // A slow model may think for minutes, but silence for this long means
        // the connection is dead rather than the model being thoughtful.
        .read_timeout(SILENCE_LIMIT)
        .timeout(TOTAL_LIMIT)
        .build()
        .map_err(|error| error.to_string())
}

/// reqwest's Display often omits the cause, which turned "timed out" into an
/// unhelpful "error sending request" in the panel.
pub(crate) fn error_chain(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);

    while let Some(current) = source {
        parts.push(current.to_string());
        source = current.source();
    }

    parts.join(": ")
}

pub(crate) fn transport_error(name: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!(
            "{name} sent no data for {}s, so the request was dropped. Large models are slow on free tiers: try again, or choose a faster model.",
            SILENCE_LIMIT.as_secs()
        );
    }

    if error.is_connect() {
        return format!("Could not connect to {name}: {}", error_chain(error));
    }

    format!("Could not reach {name}: {}", error_chain(error))
}

pub(crate) fn describe(name: &str, status: u16, detail: Option<&str>) -> String {
    match status {
        401 | 403 => match detail {
            Some(detail) => format!("{name} rejected the request: {detail}"),
            None => format!("{name} rejected this API key. Check it in Settings."),
        },
        404 | 410 => detail
            .map(str::to_string)
            .unwrap_or_else(|| format!("{name} does not offer that model (or the base URL is wrong).")),
        402 => format!(
            "{name} says this needs credit: {}",
            detail.unwrap_or("the free allowance may be used up.")
        ),
        429 => format!(
            "{name} rate limit reached. Wait a moment and try again, or switch provider."
        ),
        400 | 422 => detail
            .map(str::to_string)
            .unwrap_or_else(|| format!("{name} rejected the request for that model.")),
        status if status >= 500 => format!("{name} returned a server error. Try again shortly."),
        _ => detail
            .map(str::to_string)
            .unwrap_or_else(|| format!("{name} request failed ({status}).")),
    }
}

/// Providers phrase errors differently: `{"detail": …}` (NVIDIA),
/// `{"error": {"message": …}}` (OpenAI style), `{"error": "…"}` or
/// `{"message": …}`.
pub(crate) async fn read_detail(response: reqwest::Response) -> Option<String> {
    let text = response.text().await.ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;

    let detail = value
        .get("detail")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| value.get("error").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))?;

    Some(detail.chars().take(300).collect())
}

async fn failure(name: &str, response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let detail = read_detail(response).await;
    describe(name, status, detail.as_deref())
}

/// The provider's model catalogue (`GET /models`).
#[tauri::command]
pub async fn ai_models(endpoint: Endpoint) -> Result<Vec<String>, String> {
    endpoint.validate()?;
    let client = client()?;

    let response = endpoint
        .get(&client, "models")
        .send()
        .await
        .map_err(|error| transport_error(&endpoint.name, &error))?;

    if !response.status().is_success() {
        return Err(failure(&endpoint.name, response).await);
    }

    let value: Value = response.json().await.map_err(|error| {
        format!("{} returned an unexpected model list: {error}", endpoint.name)
    })?;

    // OpenAI style is `{"data": [{"id"}]}`; a few servers return a bare array
    // or `{"models": [...]}`.
    let items = value
        .get("data")
        .or_else(|| value.get("models"))
        .unwrap_or(&value)
        .as_array()
        .cloned()
        .unwrap_or_default();

    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|item| {
            item.get("id")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
        })
        .map(|id| id.trim_start_matches("models/").to_string())
        .collect();

    ids.sort();
    ids.dedup();

    if ids.is_empty() {
        return Err(format!("{} listed no models.", endpoint.name));
    }

    Ok(ids)
}

enum Probe {
    Working(u64),
    Failed(String),
    Unauthorized(String),
    RateLimited(String),
}

async fn probe(client: &reqwest::Client, endpoint: &Endpoint, model: &str) -> Probe {
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });

    let started = Instant::now();

    let response = match endpoint.post(client, "chat/completions").json(&body).send().await {
        Ok(response) => response,
        Err(error) => return Probe::Failed(transport_error(&endpoint.name, &error)),
    };

    let elapsed = started.elapsed().as_millis() as u64;
    let status = response.status().as_u16();

    if (200..=299).contains(&status) {
        return Probe::Working(elapsed);
    }

    let message = failure(&endpoint.name, response).await;

    match status {
        401 | 403 => Probe::Unauthorized(message),
        429 => Probe::RateLimited(message),
        _ => Probe::Failed(message),
    }
}

/// Catalogues are not capability lists, so each chosen model is tested with a
/// real one-token request; only the ones that answer count as working.
#[tauri::command]
pub async fn ai_probe(endpoint: Endpoint, models: Vec<String>) -> Result<Verification, String> {
    endpoint.validate()?;

    let client = client()?;
    let total = models.len();
    let models: Vec<String> = models.into_iter().take(MAX_PROBES).collect();

    let outcomes: Vec<(String, Probe)> = stream::iter(models)
        .map(|model| {
            let client = client.clone();
            let endpoint = endpoint.clone();

            async move {
                let first = probe(&client, &endpoint, &model).await;
                let outcome = if matches!(first, Probe::RateLimited(_)) {
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    probe(&client, &endpoint, &model).await
                } else {
                    first
                };

                (model, outcome)
            }
        })
        .buffer_unordered(3)
        .collect()
        .await;

    let mut answered: Vec<(String, u64)> = Vec::new();
    let mut latency = BTreeMap::new();
    let mut failed = BTreeMap::new();

    for (model, outcome) in outcomes {
        match outcome {
            Probe::Working(ms) => {
                latency.insert(model.clone(), ms);
                answered.push((model, ms));
            }
            Probe::Unauthorized(message) if answered.is_empty() && failed.is_empty() => {
                return Err(message);
            }
            Probe::Unauthorized(message) | Probe::RateLimited(message) | Probe::Failed(message) => {
                failed.insert(model, message);
            }
        }
    }

    answered.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));

    Ok(Verification {
        working: answered.into_iter().map(|(model, _)| model).collect(),
        latency,
        failed,
        total,
    })
}

fn reply_text(value: &Value) -> String {
    let message = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"));

    let content = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    if !content.is_empty() {
        return content.to_string();
    }

    // Reasoning models sometimes spend a tiny budget entirely on thinking.
    message
        .and_then(|message| {
            message
                .get("reasoning_content")
                .or_else(|| message.get("reasoning"))
        })
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Tiny round-trip used by the Settings connection test: it checks the key
/// and one model without waiting for a full answer.
#[tauri::command]
pub async fn ai_ping(endpoint: Endpoint, model: String) -> Result<Ping, String> {
    endpoint.validate()?;

    let client = client()?;
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "Reply with the single word: ok" }],
        "max_tokens": 16,
    });

    let started = Instant::now();
    let response = endpoint
        .post(&client, "chat/completions")
        .json(&body)
        .send()
        .await
        .map_err(|error| transport_error(&endpoint.name, &error))?;
    let ms = started.elapsed().as_millis() as u64;

    if !response.status().is_success() {
        return Err(failure(&endpoint.name, response).await);
    }

    let value: Value = response.json().await.map_err(|error| {
        format!("{} returned an unexpected reply: {error}", endpoint.name)
    })?;

    let reply = reply_text(&value);

    Ok(Ping {
        reply: if reply.is_empty() {
            "(empty reply)".to_string()
        } else {
            reply
        },
        ms,
    })
}

/// A plain, non-streaming completion: commit messages and inline suggestions.
#[tauri::command]
pub async fn ai_chat(
    endpoint: Endpoint,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    endpoint.validate()?;

    let size = messages
        .iter()
        .map(|message| message.content.len())
        .sum::<usize>();

    if size > MAX_CONTEXT_CHARS * 4 {
        return Err("That conversation is too large to send.".into());
    }

    let client = client()?;
    let body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens.unwrap_or(1024),
    });

    let response = endpoint
        .post(&client, "chat/completions")
        .json(&body)
        .send()
        .await
        .map_err(|error| transport_error(&endpoint.name, &error))?;

    if !response.status().is_success() {
        return Err(failure(&endpoint.name, response).await);
    }

    let value: Value = response.json().await.map_err(|error| {
        format!("{} returned an unexpected reply: {error}", endpoint.name)
    })?;

    let content = reply_text(&value);

    if content.is_empty() {
        return Err("The model returned an empty reply.".into());
    }

    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(base_url: &str) -> Endpoint {
        Endpoint {
            name: "Test".into(),
            base_url: base_url.into(),
            api_key: String::new(),
        }
    }

    #[test]
    fn keys_only_travel_over_https_or_to_localhost() {
        assert!(endpoint("https://api.groq.com/openai/v1").validate().is_ok());
        assert!(endpoint("http://localhost:11434/v1").validate().is_ok());
        assert!(endpoint("http://127.0.0.1:1234/v1").validate().is_ok());
        assert!(endpoint("http://example.com/v1").validate().is_err());
        assert!(endpoint("ftp://example.com").validate().is_err());
        assert!(endpoint("").validate().is_err());
        assert!(endpoint(
            "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1"
        )
        .validate()
        .is_err());
    }

    #[test]
    fn joins_paths_without_doubling_slashes() {
        assert_eq!(
            endpoint("https://openrouter.ai/api/v1/").url("chat/completions"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
    }

    #[test]
    fn reads_the_answer_or_falls_back_to_reasoning() {
        let answer = json!({ "choices": [{ "message": { "content": " ok " } }] });
        assert_eq!(reply_text(&answer), "ok");

        let thinking = json!({ "choices": [{ "message": { "content": "", "reasoning_content": "hmm" } }] });
        assert_eq!(reply_text(&thinking), "hmm");
    }

    #[test]
    fn describes_errors_with_the_provider_name() {
        assert!(describe("Groq", 429, None).starts_with("Groq rate limit"));
        assert!(describe("Groq", 401, None).contains("Groq rejected this API key"));
    }

    /// Needs Ollama running locally with at least one model pulled.
    #[test]
    #[ignore]
    fn lists_and_pings_a_local_ollama() {
        let local = Endpoint {
            name: "Ollama".into(),
            base_url: "http://localhost:11434/v1".into(),
            api_key: String::new(),
        };

        let models = tauri::async_runtime::block_on(ai_models(local.clone()))
            .expect("Ollama should list its models");
        assert!(!models.is_empty());

        let smallest = models
            .iter()
            .find(|id| id.contains("4b") || id.contains("1b") || id.contains("mini"))
            .unwrap_or(&models[0])
            .clone();
        let ping = tauri::async_runtime::block_on(ai_ping(local, smallest.clone()))
            .expect("the model should answer");
        println!("{smallest} answered {:?} in {} ms", ping.reply, ping.ms);
    }

    #[test]
    #[ignore]
    fn a_bad_key_reports_an_authorization_error() {
        let outcome = tauri::async_runtime::block_on(ai_ping(
            Endpoint {
                name: "NVIDIA NIM".into(),
                base_url: "https://integrate.api.nvidia.com/v1".into(),
                api_key: "nvapi-bogus".into(),
            },
            "z-ai/glm-5.3-flash".to_string(),
        ));

        let message = outcome.expect_err("a bogus key must fail");
        assert!(message.contains("rejected"), "unexpected message: {message}");
    }
}
