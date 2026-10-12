//! Client minimal pour l'API Mistral (compatible avec les serveurs « OpenAI-like »
//! auto-hébergés : vLLM, Ollama, llama.cpp…).

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::Notify;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
    /// Appels d'outils d'un message assistant : `[{id, name, arguments}]`.
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// Pour un message `tool` : l'appel auquel il répond.
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON encodé en chaîne, tel que renvoyé par le modèle.
    pub arguments: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Définitions d'outils au format Mistral (`[{type: "function", function: {...}}]`).
    #[serde(default)]
    pub tools: Vec<Value>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Reasoning { text: String },
    #[serde(rename_all = "camelCase")]
    Usage { prompt_tokens: u64, completion_tokens: u64 },
    ToolCalls { calls: Vec<ToolCall> },
    #[serde(rename_all = "camelCase")]
    Done { finish_reason: Option<String>, cancelled: bool },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub description: Option<String>,
    pub vision: bool,
    pub max_context_length: Option<u64>,
}

pub fn validate_base_url(url: &str) -> Result<(), String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("URL invalide : {e}"))?;
    match u.scheme() {
        "https" => Ok(()),
        // HTTP en clair toléré uniquement pour un serveur local.
        "http" if matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) => Ok(()),
        _ => Err("L'URL doit être en HTTPS (HTTP accepté seulement pour localhost)".into()),
    }
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}/v1/{}", base.trim_end_matches('/').trim_end_matches("/v1"), path)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("mistral-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.pointer("/error/message"))
                .or_else(|| v.get("detail"))
                .map(|m| m.as_str().map(str::to_owned).unwrap_or_else(|| m.to_string()))
        })
        .unwrap_or(body);
    match status.as_u16() {
        401 => "Clé API refusée (401). Vérifiez-la dans les réglages.".into(),
        429 => format!("Limite de requêtes atteinte (429). {detail}"),
        _ => format!("Erreur API {status} : {detail}"),
    }
}

pub async fn list_models(base: &str, key: &str) -> Result<Vec<ModelInfo>, String> {
    let resp = client()?
        .get(endpoint(base, "models"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut models: Vec<ModelInfo> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["capabilities"]["completion_chat"].as_bool().unwrap_or(true))
        .filter(|m| m["deprecation"].is_null())
        .filter_map(|m| {
            Some(ModelInfo {
                id: m["id"].as_str()?.to_owned(),
                description: m["description"].as_str().map(str::to_owned),
                // Inconnu (serveur tiers) => on n'empêche pas l'envoi d'images.
                vision: m["capabilities"]["vision"].as_bool().unwrap_or(true),
                max_context_length: m["max_context_length"].as_u64(),
            })
        })
        .collect();
    models.sort_by(|a, b| {
        let rank = |id: &str| if id.ends_with("-latest") { 0 } else { 1 };
        rank(&a.id).cmp(&rank(&b.id)).then(a.id.cmp(&b.id))
    });
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

fn to_api_message(m: &ChatMessage) -> Value {
    if m.role == "tool" {
        return json!({
            "role": "tool",
            "content": m.content,
            "tool_call_id": m.tool_call_id,
            "name": m.name,
        });
    }
    if !m.tool_calls.is_empty() {
        let calls: Vec<Value> = m
            .tool_calls
            .iter()
            .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } }))
            .collect();
        return json!({ "role": "assistant", "content": m.content, "tool_calls": calls });
    }
    if m.images.is_empty() {
        return json!({ "role": m.role, "content": m.content });
    }
    let mut parts = vec![json!({ "type": "text", "text": m.content })];
    parts.extend(
        m.images
            .iter()
            .map(|url| json!({ "type": "image_url", "image_url": { "url": url } })),
    );
    json!({ "role": m.role, "content": parts })
}

/// `delta.content` est soit une chaîne, soit (modèles de raisonnement Magistral)
/// une liste de blocs `text` / `thinking`.
fn emit_content(content: &Value, on_event: &Channel<StreamEvent>) {
    let send = |ev: StreamEvent| {
        let _ = on_event.send(ev);
    };
    match content {
        Value::String(s) if !s.is_empty() => send(StreamEvent::Delta { text: s.clone() }),
        Value::Array(chunks) => {
            for c in chunks {
                match c["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = c["text"].as_str() {
                            send(StreamEvent::Delta { text: t.to_owned() });
                        }
                    }
                    Some("thinking") => {
                        for t in c["thinking"].as_array().into_iter().flatten() {
                            if let Some(t) = t["text"].as_str() {
                                send(StreamEvent::Reasoning { text: t.to_owned() });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

pub async fn chat_stream(
    base: &str,
    key: &str,
    req: ChatRequest,
    on_event: &Channel<StreamEvent>,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let mut body = json!({
        "model": req.model,
        "messages": req.messages.iter().map(to_api_message).collect::<Vec<_>>(),
        "stream": true,
    });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = req.max_tokens.filter(|m| *m > 0) {
        body["max_tokens"] = json!(m);
    }
    if !req.tools.is_empty() {
        body["tools"] = json!(req.tools);
        body["tool_choice"] = json!("auto");
    }

    let send = client()?
        .post(endpoint(base, "chat/completions"))
        .bearer_auth(key)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send();

    let resp = tokio::select! {
        r = send => r.map_err(|e| format!("Connexion impossible : {e}"))?,
        _ = cancel.notified() => {
            let _ = on_event.send(StreamEvent::Done { finish_reason: None, cancelled: true });
            return Ok(());
        }
    };
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut finish_reason: Option<String> = None;
    let mut calls: Vec<ToolCall> = Vec::new();
    let flush_calls = |calls: &mut Vec<ToolCall>| {
        if !calls.is_empty() {
            for c in calls.iter_mut() {
                if c.id.is_empty() {
                    // Format attendu par l'API Mistral : 9 caractères alphanumériques.
                    c.id = uuid::Uuid::new_v4().simple().to_string()[..9].to_owned();
                }
                if c.arguments.trim().is_empty() {
                    c.arguments = "{}".into();
                }
            }
            let _ = on_event.send(StreamEvent::ToolCalls { calls: std::mem::take(calls) });
        }
    };

    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = cancel.notified() => {
                let _ = on_event.send(StreamEvent::Done { finish_reason: None, cancelled: true });
                return Ok(());
            }
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk.map_err(|e| format!("Flux interrompu : {e}"))?);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                flush_calls(&mut calls);
                let _ = on_event.send(StreamEvent::Done { finish_reason, cancelled: false });
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                return Err(format!("Erreur API : {}", err["message"].as_str().unwrap_or(&err.to_string())));
            }
            let choice = &v["choices"][0];
            emit_content(&choice["delta"]["content"], on_event);
            for (pos, tc) in choice["delta"]["tool_calls"].as_array().into_iter().flatten().enumerate() {
                let idx = tc["index"].as_u64().map(|i| i as usize).unwrap_or(pos);
                if calls.len() <= idx {
                    calls.resize_with(idx + 1, ToolCall::default);
                }
                let c = &mut calls[idx];
                if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty() && *s != "null") {
                    c.id = id.to_owned();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    c.name.push_str(n);
                }
                match &tc["function"]["arguments"] {
                    Value::String(a) => c.arguments.push_str(a),
                    Value::Null => {}
                    other => c.arguments.push_str(&other.to_string()),
                }
            }
            if let Some(fr) = choice["finish_reason"].as_str() {
                finish_reason = Some(fr.to_owned());
            }
            if let (Some(p), Some(c)) = (
                v["usage"]["prompt_tokens"].as_u64(),
                v["usage"]["completion_tokens"].as_u64(),
            ) {
                let _ = on_event.send(StreamEvent::Usage { prompt_tokens: p, completion_tokens: c });
            }
        }
    }

    flush_calls(&mut calls);
    let _ = on_event.send(StreamEvent::Done { finish_reason, cancelled: false });
    Ok(())
}

/// Recherche web via le connecteur `web_search` de l'API Conversations de Mistral.
pub async fn web_search(base: &str, key: &str, query: &str) -> Result<String, String> {
    let body = json!({
        "model": "mistral-medium-latest",
        "inputs": query,
        "tools": [{ "type": "web_search" }],
        "store": false,
        "instructions": "Recherche sur le web et rends un résumé factuel et détaillé des résultats, \
                         avec les chiffres, dates et noms exacts. Ne conclus pas, ne pose pas de question.",
    });
    let resp = client()?
        .post(endpoint(base, "conversations"))
        .bearer_auth(key)
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut text = String::new();
    let mut sources: Vec<(String, String)> = Vec::new();
    for out in v["outputs"].as_array().into_iter().flatten() {
        if out["type"] != "message.output" {
            continue;
        }
        match &out["content"] {
            Value::String(s) => text.push_str(s),
            Value::Array(chunks) => {
                for c in chunks {
                    match c["type"].as_str() {
                        Some("text") => text.push_str(c["text"].as_str().unwrap_or_default()),
                        Some("tool_reference") => {
                            if let Some(url) = c["url"].as_str() {
                                let title = c["title"].as_str().unwrap_or(url).to_owned();
                                if !sources.iter().any(|(_, u)| u == url) {
                                    sources.push((title, url.to_owned()));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if !sources.is_empty() {
        text.push_str("\n\nSources :\n");
        for (i, (title, url)) in sources.iter().enumerate() {
            text.push_str(&format!("[{}] {title} — {url}\n", i + 1));
        }
    }
    if text.trim().is_empty() {
        return Err("La recherche web n'a renvoyé aucun résultat".into());
    }
    Ok(text)
}

/// OCR d'un document (PDF) via `mistral-ocr-latest`. Renvoie le Markdown de chaque page.
pub async fn ocr(base: &str, key: &str, name: &str, data_url: &str) -> Result<String, String> {
    let body = json!({
        "model": "mistral-ocr-latest",
        "document": { "type": "document_url", "document_url": data_url, "document_name": name },
        "include_image_base64": false,
    });
    let resp = client()?
        .post(endpoint(base, "ocr"))
        .bearer_auth(key)
        .json(&body)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let pages: Vec<String> = v["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["markdown"].as_str().map(str::to_owned))
        .collect();
    Ok(pages.join("\n\n---\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_normalises_base() {
        assert_eq!(endpoint("https://api.mistral.ai", "models"), "https://api.mistral.ai/v1/models");
        assert_eq!(endpoint("https://api.mistral.ai/", "models"), "https://api.mistral.ai/v1/models");
        assert_eq!(endpoint("http://localhost:8000/v1", "models"), "http://localhost:8000/v1/models");
    }

    #[test]
    fn base_url_validation() {
        assert!(validate_base_url("https://api.mistral.ai").is_ok());
        assert!(validate_base_url("http://localhost:11434").is_ok());
        assert!(validate_base_url("http://192.168.1.10:8000").is_err());
        assert!(validate_base_url("ftp://x").is_err());
    }

    #[test]
    fn image_message_uses_content_parts() {
        let m = ChatMessage {
            role: "user".into(),
            content: "décris".into(),
            images: vec!["data:image/png;base64,AAA".into()],
            tool_calls: vec![],
            tool_call_id: None,
            name: None,
        };
        let v = to_api_message(&m);
        assert_eq!(v["content"][0]["type"], "text");
        assert_eq!(v["content"][1]["image_url"]["url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn tool_messages_round_trip() {
        let a = ChatMessage {
            role: "assistant".into(),
            content: String::new(),
            images: vec![],
            tool_calls: vec![ToolCall { id: "abc123def".into(), name: "read_file".into(), arguments: "{\"path\":\"a\"}".into() }],
            tool_call_id: None,
            name: None,
        };
        let v = to_api_message(&a);
        assert_eq!(v["tool_calls"][0]["function"]["name"], "read_file");
        let t = ChatMessage {
            role: "tool".into(),
            content: "ok".into(),
            images: vec![],
            tool_calls: vec![],
            tool_call_id: Some("abc123def".into()),
            name: Some("read_file".into()),
        };
        let v = to_api_message(&t);
        assert_eq!(v["tool_call_id"], "abc123def");
    }
}
