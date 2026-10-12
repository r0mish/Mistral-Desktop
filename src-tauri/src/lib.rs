mod mcp;
mod mistral;
mod storage;
mod tools;
mod web;
mod workspace;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Notify;

use mcp::{McpManager, ServerStatus};
use mistral::{ChatRequest, ModelInfo, StreamEvent};
use storage::{Conversation, ConversationSummary, Settings};
use tools::{ToolContext, ToolDef, ToolOutput};

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

// ------------------------------------------------------------------ outils

#[tauri::command]
fn tool_definitions(mcp: State<'_, Arc<McpManager>>, ctx: ToolContext) -> Vec<ToolDef> {
    tools::definitions(&ctx, &mcp)
}

#[tauri::command]
fn preview_tool(app: AppHandle, ctx: ToolContext, name: String, arguments: String) -> CmdResult<Option<String>> {
    tools::preview(&ctx, &storage::load_workspaces(&app), &name, &arguments)
}

#[tauri::command]
async fn run_tool(
    app: AppHandle,
    streams: State<'_, Streams>,
    mcp: State<'_, Arc<McpManager>>,
    request_id: String,
    ctx: ToolContext,
    name: String,
    arguments: String,
) -> CmdResult<ToolOutput> {
    let settings = storage::load_settings(&app)?;
    let approved = storage::load_workspaces(&app);
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let env = tools::RunEnv { settings: &settings, api_key: api_key(), approved: &approved, mcp: &mcp, cancel: cancel.clone() };
    let out = if name == "run_command" {
        // La commande gère elle-même l'annulation (arrêt du groupe de processus).
        tools::run(&ctx, env, &name, &arguments).await
    } else {
        tokio::select! {
            o = tools::run(&ctx, env, &name, &arguments) => o,
            _ = cancel.notified() => ToolOutput { content: "Annulé par l'utilisateur".into(), is_error: true, diff: None },
        }
    };
    streams.0.lock().unwrap().remove(&request_id);
    Ok(out)
}

// ------------------------------------------------------------------ dossiers de projet

#[tauri::command]
async fn pick_workspace(app: AppHandle) -> CmdResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Choisir le dossier du projet").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let path = path.canonicalize().map_err(|e| e.to_string())?.display().to_string();
    storage::add_workspace(&app, &path)?;
    Ok(Some(path))
}

#[tauri::command]
fn list_workspaces(app: AppHandle) -> Vec<String> {
    storage::load_workspaces(&app)
}

#[tauri::command]
fn forget_workspace(app: AppHandle, path: String) -> CmdResult<Vec<String>> {
    storage::remove_workspace(&app, &path)
}

#[tauri::command]
fn touch_workspace(app: AppHandle, path: String) -> CmdResult<()> {
    // Ne fait que remonter un dossier déjà autorisé en tête de liste.
    if storage::load_workspaces(&app).contains(&path) {
        storage::add_workspace(&app, &path)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ documents

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentText {
    text: String,
    method: &'static str,
}

fn extract_pdf_local(bytes: Vec<u8>) -> CmdResult<(String, usize)> {
    let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|e| e.to_string())?;
    let pages = text.matches('\u{c}').count().max(1);
    Ok((text, pages))
}

/// Convertit un PDF en texte : extraction locale, ou OCR Mistral (PDF scannés, mise en page complexe).
#[tauri::command]
async fn process_document(app: AppHandle, name: String, data_base64: String) -> CmdResult<DocumentText> {
    let settings = storage::load_settings(&app)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Fichier illisible : {e}"))?;
    if !bytes.starts_with(b"%PDF") {
        return Err("Ce fichier n'est pas un PDF".into());
    }
    let ocr = || async {
        let url = format!("data:application/pdf;base64,{data_base64}");
        mistral::ocr(&settings.base_url, &api_key()?, &name, &url).await
    };
    match settings.pdf_mode.as_str() {
        "ocr" => Ok(DocumentText { text: ocr().await?, method: "ocr" }),
        mode => {
            let local = tokio::task::spawn_blocking(move || extract_pdf_local(bytes))
                .await
                .map_err(|_| "L'extraction locale a échoué sur ce PDF".to_string())
                .and_then(|r| r);
            match (mode, local) {
                ("local", Ok((text, _))) => Ok(DocumentText { text, method: "local" }),
                ("local", Err(e)) => Err(format!("Extraction locale impossible : {e}")),
                // auto : on bascule sur l'OCR si le PDF semble scanné (presque pas de texte).
                (_, Ok((text, pages))) if text.trim().chars().count() >= 80 * pages => Ok(DocumentText { text, method: "local" }),
                _ => Ok(DocumentText { text: ocr().await?, method: "ocr" }),
            }
        }
    }
}

// ------------------------------------------------------------------ MCP

#[tauri::command]
fn mcp_get_config(app: AppHandle) -> String {
    storage::load_mcp_config(&app)
}

#[tauri::command]
async fn mcp_save_config(app: AppHandle, mcp: State<'_, Arc<McpManager>>, text: String) -> CmdResult<()> {
    let cfg = mcp::parse_config(&text)?;
    storage::save_mcp_config(&app, &text)?;
    mcp.inner().restart(cfg).await;
    Ok(())
}

#[tauri::command]
async fn mcp_restart(app: AppHandle, mcp: State<'_, Arc<McpManager>>) -> CmdResult<()> {
    let cfg = mcp::parse_config(&storage::load_mcp_config(&app))?;
    mcp.inner().restart(cfg).await;
    Ok(())
}

#[tauri::command]
fn mcp_status(mcp: State<'_, Arc<McpManager>>) -> Vec<ServerStatus> {
    mcp.status()
}

#[tauri::command]
fn platform_info() -> serde_json::Value {
    serde_json::json!({ "os": std::env::consts::OS, "shell": workspace::shell_name() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(unix)]
    mcp::fix_path_env();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Streams::default())
        .manage(Arc::new(McpManager::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mgr = handle.state::<Arc<McpManager>>().inner().clone();
                match mcp::parse_config(&storage::load_mcp_config(&handle)) {
                    Ok(cfg) => mgr.restart(cfg).await,
                    Err(e) => eprintln!("mcp.json invalide : {e}"),
                }
            });
            Ok(())
        })
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
            tool_definitions,
            preview_tool,
            run_tool,
            pick_workspace,
            list_workspaces,
            forget_workspace,
            touch_workspace,
            process_document,
            mcp_get_config,
            mcp_save_config,
            mcp_restart,
            mcp_status,
            platform_info,
        ])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Arrêt propre des serveurs MCP (processus enfants).
            let mgr = handle.state::<Arc<McpManager>>().inner().clone();
            tauri::async_runtime::block_on(mgr.shutdown());
        }
    });
}

#[cfg(test)]
mod tests {
    /// PDF minimal d'une page contenant `text` (police standard Helvetica).
    pub fn tiny_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 11 Tf 40 760 Td ({text}) Tj ET");
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        ];
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{o}\nendobj\n", i + 1));
        }
        let xref = out.len();
        out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1));
        for o in offsets {
            out.push_str(&format!("{o:010} 00000 n \n"));
        }
        out.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1));
        out.into_bytes()
    }

    #[test]
    fn local_pdf_extraction() {
        let (text, pages) = super::extract_pdf_local(tiny_pdf("Rapport annuel 2026")).unwrap();
        assert!(text.contains("Rapport annuel 2026"), "{text:?}");
        assert_eq!(pages, 1);
    }
}
