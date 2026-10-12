mod mistral;
mod storage;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{ipc::Channel, AppHandle, State};
use tokio::sync::Notify;

use mistral::{ChatRequest, ModelInfo, StreamEvent};
use storage::{Conversation, ConversationSummary, Settings};

const KEYRING_SERVICE: &str = "dev.r0mish.mistral-desktop";
const KEYRING_USER: &str = "mistral-api-key";
const ENV_API_KEY: &str = "MISTRAL_API_KEY";

/// Requêtes en cours, annulables depuis l'interface.
#[derive(Default)]
struct Streams(Mutex<HashMap<String, Arc<Notify>>>);

type CmdResult<T> = Result<T, String>;

fn keyring_entry() -> CmdResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// Clé API : trousseau du système d'abord, variable d'environnement en repli
/// (utile sur un bureau Linux sans Secret Service).
fn api_key() -> CmdResult<String> {
    if let Ok(key) = keyring_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    match std::env::var(ENV_API_KEY) {
        Ok(key) if !key.is_empty() => Ok(key),
        _ => Err("Aucune clé API configurée. Ouvrez les réglages pour l'ajouter.".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyStatus {
    configured: bool,
    source: Option<&'static str>,
}

#[tauri::command]
fn api_key_status() -> KeyStatus {
    let in_keyring = keyring_entry()
        .and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    if in_keyring {
        return KeyStatus { configured: true, source: Some("keyring") };
    }
    if std::env::var(ENV_API_KEY).map(|k| !k.is_empty()).unwrap_or(false) {
        return KeyStatus { configured: true, source: Some("env") };
    }
    KeyStatus { configured: false, source: None }
}

#[tauri::command]
fn set_api_key(key: String) -> CmdResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Clé vide".into());
    }
    keyring_entry()?
        .set_password(key)
        .map_err(|e| format!("Impossible d'écrire dans le trousseau du système : {e}"))
}

#[tauri::command]
fn delete_api_key() -> CmdResult<()> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> CmdResult<Settings> {
    storage::load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> CmdResult<()> {
    mistral::validate_base_url(&settings.base_url)?;
    storage::save_settings(&app, &settings)
}

#[tauri::command]
async fn list_models(app: AppHandle) -> CmdResult<Vec<ModelInfo>> {
    let settings = storage::load_settings(&app)?;
    mistral::list_models(&settings.base_url, &api_key()?).await
}

#[tauri::command]
fn list_conversations(app: AppHandle) -> CmdResult<Vec<ConversationSummary>> {
    storage::list_conversations(&app)
}

#[tauri::command]
fn load_conversation(app: AppHandle, id: String) -> CmdResult<Conversation> {
    storage::load_conversation(&app, &id)
}

#[tauri::command]
fn save_conversation(app: AppHandle, conversation: Conversation) -> CmdResult<()> {
    storage::save_conversation(&app, &conversation)
}

#[tauri::command]
fn delete_conversation(app: AppHandle, id: String) -> CmdResult<()> {
    storage::delete_conversation(&app, &id)
}

#[tauri::command]
async fn export_conversation(app: AppHandle, id: String) -> CmdResult<bool> {
    storage::export_conversation(&app, &id).await
}

#[tauri::command]
fn data_dir(app: AppHandle) -> CmdResult<String> {
    storage::data_dir(&app).map(|p| p.display().to_string())
}

#[tauri::command]
async fn chat_stream(
    app: AppHandle,
    streams: State<'_, Streams>,
    request_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
) -> CmdResult<()> {
    let settings = storage::load_settings(&app)?;
    let key = api_key()?;
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let result = mistral::chat_stream(&settings.base_url, &key, request, &on_event, cancel).await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

#[tauri::command]
fn cancel_stream(streams: State<'_, Streams>, request_id: String) {
    if let Some(n) = streams.0.lock().unwrap().get(&request_id) {
        n.notify_one();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Streams::default())
        .invoke_handler(tauri::generate_handler![
            api_key_status,
            set_api_key,
            delete_api_key,
            get_settings,
            save_settings,
            list_models,
            list_conversations,
            load_conversation,
            save_conversation,
            delete_conversation,
            export_conversation,
            data_dir,
            chat_stream,
            cancel_stream,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
