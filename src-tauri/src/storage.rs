//! Stockage local en JSON, sans base de données ni service tiers.
//!   <config>/settings.json
//!   <data>/conversations/<id>.json + index.json

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub base_url: String,
    pub default_model: String,
    pub system_prompt: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub theme: String,
    pub send_on_enter: bool,
    /// « mistral » (connecteur web_search) ou « searxng » (instance auto-hébergée).
    pub web_search_provider: String,
    pub searxng_url: String,
    /// Recherche web activée par défaut dans les nouvelles conversations.
    pub web_search_default: bool,
    /// PDF : « auto » (extraction locale, OCR si PDF scanné), « local » ou « ocr ».
    pub pdf_mode: String,
    pub code_model: String,
    /// Délai max d'une commande du mode Code, en secondes.
    pub command_timeout: u64,
    /// Outils MCP exécutés sans demander (noms exposés).
    pub mcp_always_allow: Vec<String>,
    /// Nombre max d'étapes (appels au modèle) d'un tour de l'agent de code.
    pub max_steps: u32,
    /// Relance l'agent s'il s'arrête en annonçant une action sans l'exécuter.
    pub auto_continue: bool,
    /// Résume automatiquement l'historique au-delà de ce pourcentage du contexte (0 = jamais).
    pub auto_compact_percent: u32,
    pub check_updates: bool,
    pub skipped_version: String,
    /// Shell de l'agent : « auto », « bash » (Git Bash), « pwsh » ou « powershell » (Windows).
    pub shell: String,
    /// Tarifs en $ par million de tokens : « préfixe de modèle » → [entrée, sortie].
    pub prices: std::collections::BTreeMap<String, [f64; 2]>,
}

/// Tarifs indicatifs (sources tierces, octobre 2026) : modifiables dans les réglages.
fn default_prices() -> std::collections::BTreeMap<String, [f64; 2]> {
    [
        ("mistral-large", [0.5, 1.5]),
        ("mistral-medium", [1.5, 7.5]),
        ("mistral-small", [0.15, 0.6]),
        ("magistral-medium", [2.0, 5.0]),
        ("magistral-small", [0.5, 1.5]),
        ("devstral-medium", [0.4, 2.0]),
        ("devstral-latest", [0.4, 2.0]),
        ("devstral-small", [0.1, 0.3]),
        ("codestral", [0.3, 0.9]),
        ("ministral", [0.1, 0.1]),
        ("pixtral-large", [2.0, 6.0]),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.mistral.ai".into(),
            default_model: "mistral-medium-latest".into(),
            system_prompt: String::new(),
            temperature: None,
            max_tokens: None,
            theme: "system".into(),
            send_on_enter: true,
            web_search_provider: "mistral".into(),
            searxng_url: String::new(),
            web_search_default: false,
            pdf_mode: "auto".into(),
            code_model: "devstral-medium-latest".into(),
            command_timeout: 120,
            mcp_always_allow: Vec::new(),
            max_steps: 100,
            auto_continue: true,
            auto_compact_percent: 80,
            check_updates: true,
            skipped_version: String::new(),
            shell: "auto".into(),
            prices: default_prices(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// Champs propres à l'interface (id, images, raisonnement, usage…), conservés tels quels.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// « chat » ou « code ».
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
    /// Champs propres à l'interface (dossier de projet, mode d'approbation, outils…).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_kind() -> String {
    "chat".into()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub workspace: Option<String>,
}

impl From<&Conversation> for ConversationSummary {
    fn from(c: &Conversation) -> Self {
        Self {
            id: c.id.clone(),
            title: c.title.clone(),
            updated_at: c.updated_at,
            kind: c.kind.clone(),
            workspace: c.extra.get("workspace").and_then(Value::as_str).map(str::to_owned),
        }
    }
}

fn ensure_dir(p: PathBuf) -> R<PathBuf> {
    fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p)
}

pub fn data_dir(app: &AppHandle) -> R<PathBuf> {
    ensure_dir(app.path().app_data_dir().map_err(|e| e.to_string())?)
}

fn conv_dir(app: &AppHandle) -> R<PathBuf> {
    ensure_dir(data_dir(app)?.join("conversations"))
}

fn settings_path(app: &AppHandle) -> R<PathBuf> {
    Ok(ensure_dir(app.path().app_config_dir().map_err(|e| e.to_string())?)?.join("settings.json"))
}

/// Écriture atomique (fichier temporaire + rename) pour ne jamais corrompre l'historique.
fn write_atomic(path: &Path, bytes: &[u8]) -> R<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> R<()> {
    write_atomic(path, &serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
}

/// Les identifiants servent de nom de fichier : on refuse tout ce qui n'est pas [A-Za-z0-9-].
fn check_id(id: &str) -> R<()> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("Identifiant de conversation invalide".into())
    }
}

pub fn load_settings(app: &AppHandle) -> R<Settings> {
    let path = settings_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(Settings::default()),
    }
}

pub fn save_settings(app: &AppHandle, s: &Settings) -> R<()> {
    write_json(&settings_path(app)?, s)
}

fn index_path(app: &AppHandle) -> R<PathBuf> {
    Ok(conv_dir(app)?.join("index.json"))
}

fn rebuild_index(app: &AppHandle) -> R<Vec<ConversationSummary>> {
    let dir = conv_dir(app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") || p.ends_with("index.json") {
            continue;
        }
        if let Ok(c) = fs::read(&p).map_err(|_| ()).and_then(|b| serde_json::from_slice::<Conversation>(&b).map_err(|_| ())) {
            out.push(ConversationSummary::from(&c));
        }
    }
    write_json(&index_path(app)?, &out)?;
    Ok(out)
}

fn read_index(app: &AppHandle) -> R<Vec<ConversationSummary>> {
    match fs::read(index_path(app)?).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(idx) => Ok(idx),
        None => rebuild_index(app),
    }
}

pub fn list_conversations(app: &AppHandle) -> R<Vec<ConversationSummary>> {
    let mut idx = read_index(app)?;
    idx.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(idx)
}

pub fn load_conversation(app: &AppHandle, id: &str) -> R<Conversation> {
    check_id(id)?;
    let bytes = fs::read(conv_dir(app)?.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn save_conversation(app: &AppHandle, c: &Conversation) -> R<()> {
    check_id(&c.id)?;
    write_json(&conv_dir(app)?.join(format!("{}.json", c.id)), c)?;
    let mut idx = read_index(app)?;
    idx.retain(|s| s.id != c.id);
    idx.push(c.into());
    write_json(&index_path(app)?, &idx)
}

pub fn delete_conversation(app: &AppHandle, id: &str) -> R<()> {
    check_id(id)?;
    let path = conv_dir(app)?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let mut idx = read_index(app)?;
    idx.retain(|s| s.id != id);
    write_json(&index_path(app)?, &idx)
}

fn workspaces_path(app: &AppHandle) -> R<PathBuf> {
    Ok(data_dir(app)?.join("workspaces.json"))
}

/// Dossiers de projet autorisés : uniquement ceux choisis via la boîte de dialogue native.
pub fn load_workspaces(app: &AppHandle) -> Vec<String> {
    workspaces_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn add_workspace(app: &AppHandle, path: &str) -> R<Vec<String>> {
    let mut list = load_workspaces(app);
    list.retain(|p| p != path);
    list.insert(0, path.to_owned());
    list.truncate(30);
    write_json(&workspaces_path(app)?, &list)?;
    Ok(list)
}

pub fn remove_workspace(app: &AppHandle, path: &str) -> R<Vec<String>> {
    let mut list = load_workspaces(app);
    list.retain(|p| p != path);
    write_json(&workspaces_path(app)?, &list)?;
    Ok(list)
}

/// Consommation agrégée par jour et par modèle : `{"2026-10-12": {"modèle": [entrée, sortie, requêtes]}}`.
pub type UsageLog = std::collections::BTreeMap<String, std::collections::BTreeMap<String, [u64; 3]>>;

fn usage_path(app: &AppHandle) -> R<PathBuf> {
    Ok(data_dir(app)?.join("usage.json"))
}

pub fn load_usage(app: &AppHandle) -> UsageLog {
    usage_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn record_usage(app: &AppHandle, day: &str, model: &str, prompt: u64, completion: u64) -> R<()> {
    let mut log = load_usage(app);
    let e = log.entry(day.to_owned()).or_default().entry(model.to_owned()).or_insert([0, 0, 0]);
    e[0] += prompt;
    e[1] += completion;
    e[2] += 1;
    write_json(&usage_path(app)?, &log)
}

fn mcp_path(app: &AppHandle) -> R<PathBuf> {
    Ok(ensure_dir(app.path().app_config_dir().map_err(|e| e.to_string())?)?.join("mcp.json"))
}

pub fn load_mcp_config(app: &AppHandle) -> String {
    mcp_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{\n  \"mcpServers\": {}\n}\n".into())
}

pub fn save_mcp_config(app: &AppHandle, text: &str) -> R<()> {
    write_atomic(&mcp_path(app)?, text.as_bytes())
}

fn to_markdown(c: &Conversation) -> String {
    let mut md = format!("# {}\n\n", c.title);
    if !c.model.is_empty() {
        md.push_str(&format!("_Modèle : {}_\n\n", c.model));
    }
    for m in &c.messages {
        let who = match m.role.as_str() {
            "user" => "Vous".to_string(),
            "assistant" => match m.extra.get("model").and_then(Value::as_str) {
                Some(model) => format!("Mistral ({model})"),
                None => "Mistral".into(),
            },
            other => other.to_string(),
        };
        if m.role == "assistant" && m.content.trim().is_empty() && m.extra.contains_key("toolCalls") {
            // Tour purement « outils » : on le résume sous le message précédent.
        } else {
            md.push_str(&format!("## {who}\n\n{}\n\n", m.content.trim()));
        }
        for tc in m.extra.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            md.push_str(&format!(
                "> 🔧 `{}` {}\n\n",
                tc["name"].as_str().unwrap_or("?"),
                tc["arguments"].as_str().unwrap_or("").chars().take(200).collect::<String>()
            ));
        }
        let images = m.extra.get("images").and_then(Value::as_array).map_or(0, Vec::len);
        if images > 0 {
            md.push_str(&format!("_[{images} image(s) jointe(s)]_\n\n"));
        }
    }
    md
}

fn safe_filename(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    let s = s.trim();
    if s.is_empty() { "conversation".into() } else { s.to_string() }
}

/// Ouvre une boîte « Enregistrer sous » native et écrit la conversation en Markdown.
/// Le chemin n'est jamais fourni par la WebView.
pub async fn export_conversation(app: &AppHandle, id: &str) -> R<bool> {
    let conv = load_conversation(app, id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(format!("{}.md", safe_filename(&conv.title)))
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, to_markdown(&conv)).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_directory() {
        assert!(check_id("2f1c-abc").is_ok());
        assert!(check_id("../etc/passwd").is_err());
        assert!(check_id("a/b").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn unknown_message_fields_round_trip() {
        let raw = r#"{"role":"assistant","content":"ok","model":"m","reasoning":"r"}"#;
        let m: Message = serde_json::from_str(raw).unwrap();
        let back = serde_json::to_value(&m).unwrap();
        assert_eq!(back["reasoning"], "r");
        assert_eq!(back["model"], "m");
    }
}
