use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub(crate) const BASE: &str = "https://integrate.api.nvidia.com/v1";
const MAX_CONTEXT_CHARS: usize = 24_000;

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct Verification {
    /// Fastest first, so the default pick is a model that answers quickly.
    pub working: Vec<String>,
    /// Probe round-trip in milliseconds, keyed by model id.
    pub latency: BTreeMap<String, u64>,
    pub total: usize,
}

enum Probe {
    Working(u64),
    Unavailable,
    Unauthorized,
    RateLimited,
}

/// A 550B model on the free tier can think for minutes before its first token,
/// so silence is only treated as a dead connection well past that.
const SILENCE_LIMIT: Duration = Duration::from_secs(300);
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

pub(crate) fn transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!(
            "NVIDIA NIM sent no data for {}s, so the request was dropped. Large models are slow on the free tier: try again, or choose a faster model in Settings.",
            SILENCE_LIMIT.as_secs()
        );
    }

    if error.is_connect() {
        return format!("Could not connect to NVIDIA NIM: {}", error_chain(error));
    }

    format!("Could not reach NVIDIA NIM: {}", error_chain(error))
}

pub(crate) fn describe(status: u16, detail: Option<&str>) -> String {
    match status {
        401 | 403 => {
            "NVIDIA rejected this API key. Check it at build.nvidia.com/settings/api-keys.".into()
        }
        404 | 410 => detail
            .map(str::to_string)
            .unwrap_or_else(|| "That model is no longer available.".into()),
        429 => "NVIDIA rate limit reached (40 requests per minute on the free tier). Wait a moment and try again.".into(),
        400 | 422 => detail
            .map(str::to_string)
            .unwrap_or_else(|| "NVIDIA rejected the request for that model.".into()),
        status if status >= 500 => "NVIDIA NIM returned a server error. Try again shortly.".into(),
        _ => detail
            .map(str::to_string)
            .unwrap_or_else(|| format!("NVIDIA NIM request failed ({status}).")),
    }
}

pub(crate) async fn read_detail(response: reqwest::Response) -> Option<String> {
    let text = response.text().await.ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("detail")
        .and_then(|detail| detail.as_str())
        .map(str::to_string)
}

async fn list_models(client: &reqwest::Client) -> Result<Vec<String>, String> {
    let response = client
        .get(format!("{BASE}/models"))
        .send()
        .await
        .map_err(|error| transport_error(&error))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let detail = read_detail(response).await;
        return Err(describe(status, detail.as_deref()));
    }

    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("NVIDIA returned an unexpected catalogue: {error}"))?;

    let mut ids: Vec<String> = value
        .get("data")
        .and_then(|data| data.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    ids.sort();
    Ok(ids)
}

async fn probe(client: &reqwest::Client, key: &str, model: &str) -> Probe {
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });

    let started = Instant::now();

    let Ok(response) = client
        .post(format!("{BASE}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
    else {
        return Probe::Unavailable;
    };

    let elapsed = started.elapsed().as_millis() as u64;

    match response.status().as_u16() {
        200..=299 => Probe::Working(elapsed),
        401 | 403 => Probe::Unauthorized,
        429 => Probe::RateLimited,
        _ => Probe::Unavailable,
    }
}

/// The catalogue is not a capability list, so every model is tested with a
/// real one-token request and only the ones that answer are returned.
#[tauri::command]
pub async fn nim_verify(api_key: String) -> Result<Verification, String> {
    let key = api_key.trim().to_string();

    if key.is_empty() {
        return Err("Enter your NVIDIA API key first.".into());
    }

    let client = client()?;
    let models = list_models(&client).await?;
    let total = models.len();

    let outcomes: Vec<(String, Probe)> = stream::iter(models)
        .map(|model| {
            let client = client.clone();
            let key = key.clone();

            async move {
                let first = probe(&client, &key, &model).await;
                let outcome = if matches!(first, Probe::RateLimited) {
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                    probe(&client, &key, &model).await
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

    for (model, outcome) in outcomes {
        match outcome {
            Probe::Working(ms) => {
                latency.insert(model.clone(), ms);
                answered.push((model, ms));
            }
            Probe::Unauthorized => {
                return Err(describe(403, None));
            }
            _ => {}
        }
    }

    answered.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));

    Ok(Verification {
        working: answered.into_iter().map(|(model, _)| model).collect(),
        latency,
        total,
    })
}

/// Tiny round-trip used by the Settings connection test: it checks the key
/// and the chosen model without waiting for a full answer.
#[tauri::command]
pub async fn nim_ping(api_key: String, model: String) -> Result<String, String> {
    let key = api_key.trim();

    if key.is_empty() {
        return Err("Enter your NVIDIA API key first.".into());
    }

    let client = client()?;
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "Reply with the single word: ok" }],
        "max_tokens": 8,
    });

    let response = client
        .post(format!("{BASE}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|error| transport_error(&error))?;

    let status = response.status().as_u16();

    if !(200..=299).contains(&status) {
        let detail = read_detail(response).await;
        return Err(describe(status, detail.as_deref()));
    }

    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("NVIDIA returned an unexpected reply: {error}"))?;

    let content = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(if content.is_empty() {
        "(empty reply)".to_string()
    } else {
        content
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn a_bad_key_reports_an_authorization_error() {
        let outcome = tauri::async_runtime::block_on(nim_ping(
            "nvapi-bogus".to_string(),
            "z-ai/glm-5.3-flash".to_string(),
        ));

        let message = outcome.expect_err("a bogus key must fail");
        assert!(
            message.contains("rejected this API key"),
            "unexpected message: {message}"
        );
    }
}

#[tauri::command]
pub async fn nim_chat(
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let trimmed = messages
        .iter()
        .map(|message| message.content.len())
        .sum::<usize>();

    if trimmed > MAX_CONTEXT_CHARS * 4 {
        return Err("That conversation is too large to send.".into());
    }

    let client = client()?;
    let body = json!({ "model": model, "messages": messages, "max_tokens": 1024 });

    let response = client
        .post(format!("{BASE}/chat/completions"))
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| transport_error(&error))?;

    let status = response.status().as_u16();

    if !(200..=299).contains(&status) {
        let detail = read_detail(response).await;
        return Err(describe(status, detail.as_deref()));
    }

    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("NVIDIA returned an unexpected reply: {error}"))?;

    let content = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if content.is_empty() {
        return Err("The model returned an empty reply.".into());
    }

    Ok(content)
}
