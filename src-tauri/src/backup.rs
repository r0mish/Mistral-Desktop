//! Sauvegarde complète chiffrée par phrase de passe, restaurable sur un autre appareil :
//! conversations, projets, mémoire, assistants, serveurs SSH (sans mots de passe) et MCP.
//!
//! Format : `MDBAK1\n` | m_kib, t, p (u32 LE, paramètres Argon2id) | sel (16) | nonce (24) | données.
//! Clé : Argon2id(phrase, sel) ; chiffrement XChaCha20-Poly1305, l'en-tête étant authentifié (AAD).
//! Indépendante de la clé du trousseau : seule la phrase de passe permet de la lire.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::ssh::SshHost;
use crate::storage::{Assistant, Conversation, Memory, Project};

type R<T> = Result<T, String>;

const MAGIC: &[u8] = b"MDBAK1\n";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 7 + 12 + SALT_LEN + NONCE_LEN;
pub const MIN_PASSPHRASE: usize = 12;
/// Argon2id : 64 Mio, 3 passes (recommandations OWASP).
const M_KIB: u32 = 64 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Bundle {
    pub version: u32,
    pub created_at: i64,
    pub app_version: String,
    pub conversations: Vec<Conversation>,
    pub projects: Vec<Project>,
    pub memories: Vec<Memory>,
    pub assistants: Vec<Assistant>,
    pub ssh_hosts: Vec<SshHost>,
    pub mcp_config: String,
}

fn derive(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> R<[u8; 32]> {
    // Bornes : un fichier piégé ne doit pas faire allouer des gigaoctets.
    if !(8 * 1024..=1024 * 1024).contains(&m) || !(1..=10).contains(&t) || !(1..=8).contains(&p) {
        return Err("Paramètres de sauvegarde invalides".into());
    }
    let params = Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

pub fn seal(passphrase: &str, plain: &[u8]) -> R<Vec<u8>> {
    seal_with(passphrase, plain, M_KIB, T_COST, P_COST)
}

fn seal_with(passphrase: &str, plain: &[u8], m: u32, t: u32, p: u32) -> R<Vec<u8>> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Phrase de passe trop courte ({MIN_PASSPHRASE} caractères minimum)"));
    }
    let mut salt = [0u8; SALT_LEN];
    chacha20poly1305::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    for v in [m, t, p] {
        header.extend_from_slice(&v.to_le_bytes());
    }
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);
    let key = derive(passphrase, &salt, m, t, p)?;
    let ct = XChaCha20Poly1305::new(Key::from_slice(&key))
        .encrypt(&nonce, Payload { msg: plain, aad: &header })
        .map_err(|_| "Chiffrement impossible".to_string())?;
    header.extend_from_slice(&ct);
    Ok(header)
}

pub fn open(passphrase: &str, data: &[u8]) -> R<Vec<u8>> {
    if !data.starts_with(MAGIC) {
        return Err("Ce fichier n'est pas une sauvegarde Mistral Desktop".into());
    }
    if data.len() < HEADER_LEN {
        return Err("Sauvegarde tronquée".into());
    }
    let (header, ct) = data.split_at(HEADER_LEN);
    let u = |i: usize| u32::from_le_bytes(header[MAGIC.len() + 4 * i..MAGIC.len() + 4 * i + 4].try_into().unwrap());
    let salt = &header[MAGIC.len() + 12..MAGIC.len() + 12 + SALT_LEN];
    let nonce = &header[MAGIC.len() + 12 + SALT_LEN..];
    let key = derive(passphrase, salt, u(0), u(1), u(2))?;
    XChaCha20Poly1305::new(Key::from_slice(&key))
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: header })
        .map_err(|_| "Phrase de passe incorrecte ou sauvegarde altérée".into())
}

// ------------------------------------------------------------------ export / import

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const EXTENSION: &str = "mdbackup";

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn collect(app: &AppHandle) -> R<Bundle> {
    use crate::storage as st;
    let mut conversations = Vec::new();
    for s in st::list_conversations(app)? {
        conversations.push(st::load_conversation(app, &s.id)?);
    }
    Ok(Bundle {
        version: 1,
        created_at: now_ms(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        conversations,
        projects: st::list_projects(app)?,
        memories: st::load_memories(app)?,
        assistants: st::load_assistants(app)?,
        ssh_hosts: st::load_ssh_hosts(app),
        mcp_config: st::load_mcp_config(app),
    })
}

/// Contenu de la sauvegarde, pour l'afficher avant de choisir l'emplacement.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub conversations: usize,
    pub projects: usize,
    pub memories: usize,
    pub assistants: usize,
    pub ssh_hosts: usize,
    pub mcp: bool,
}

/// Exporte toutes les données dans un fichier choisi par l'utilisateur. `None` : annulé.
pub async fn export(app: &AppHandle, passphrase: &str) -> R<Option<Report>> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Phrase de passe trop courte ({MIN_PASSPHRASE} caractères minimum)"));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let day = chrono_day();
    app.dialog()
        .file()
        .add_filter("Sauvegarde Mistral Desktop", &[EXTENSION])
        .set_file_name(format!("mistral-desktop-{day}.{EXTENSION}"))
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let bundle = collect(app)?;
    let report = Report {
        conversations: bundle.conversations.len(),
        projects: bundle.projects.len(),
        memories: bundle.memories.len(),
        assistants: bundle.assistants.len(),
        ssh_hosts: bundle.ssh_hosts.len(),
        mcp: !bundle.mcp_config.trim().is_empty(),
    };
    let plain = serde_json::to_vec(&bundle).map_err(|e| e.to_string())?;
    let pass = passphrase.to_owned();
    // Argon2id (64 Mio) : hors du thread de l'interface.
    let sealed = tauri::async_runtime::spawn_blocking(move || seal(&pass, &plain)).await.map_err(|e| e.to_string())??;
    std::fs::write(&path, sealed).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(report))
}

/// Date du jour (AAAA-MM-JJ, UTC) pour le nom du fichier, sans dépendance.
fn chrono_day() -> String {
    let days = now_ms() / 86_400_000;
    // Algorithme civil de H. Hinnant.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Fusionne une sauvegarde avec les données présentes : rien n'est supprimé. À identifiant égal,
/// la version la plus récente l'emporte ; la configuration MCP n'est restaurée que si elle est vide ici.
pub fn merge(app: &AppHandle, b: Bundle) -> R<Report> {
    use crate::storage as st;
    let mut r = Report::default();
    let existing: std::collections::HashMap<String, i64> = st::list_conversations(app)?.into_iter().map(|s| (s.id, s.updated_at)).collect();
    for c in b.conversations {
        if existing.get(&c.id).is_none_or(|&t| c.updated_at > t) {
            st::save_conversation(app, &c)?;
            r.conversations += 1;
        }
    }
    let projects: std::collections::HashMap<String, i64> = st::list_projects(app)?.into_iter().map(|p| (p.id, p.updated_at)).collect();
    for p in b.projects {
        if projects.get(&p.id).is_none_or(|&t| p.updated_at > t) {
            st::save_project(app, &p)?;
            r.projects += 1;
        }
    }
    let mut memories = st::load_memories(app)?;
    for m in b.memories {
        let len = m.text.trim().chars().count();
        if (1..=st::MAX_MEMORY_CHARS).contains(&len) && memories.len() < st::MAX_MEMORIES && !memories.iter().any(|x| x.text.eq_ignore_ascii_case(&m.text)) {
            memories.push(m);
            r.memories += 1;
        }
    }
    st::save_memories(app, &memories)?;
    let mut assistants = st::load_assistants(app)?;
    for a in b.assistants {
        if !assistants.iter().any(|x| x.id == a.id) {
            assistants.push(a);
            r.assistants += 1;
        }
    }
    st::save_assistants(app, &assistants)?;
    let mut hosts = st::load_ssh_hosts(app);
    for h in b.ssh_hosts {
        if !hosts.iter().any(|x| x.id == h.id) {
            hosts.push(h);
            r.ssh_hosts += 1;
        }
    }
    st::save_ssh_hosts(app, &hosts)?;
    if !b.mcp_config.trim().is_empty() && st::load_mcp_config(app).trim().is_empty() {
        st::save_mcp_config(app, &b.mcp_config)?;
        r.mcp = true;
    }
    Ok(r)
}

/// Choisit une sauvegarde, la déchiffre et la fusionne. `None` : annulé.
pub async fn import(app: &AppHandle, passphrase: &str) -> R<Option<Report>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Sauvegarde Mistral Desktop", &[EXTENSION])
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let data = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if data.len() > 2 * 1024 * 1024 * 1024 {
        return Err("Sauvegarde trop volumineuse".into());
    }
    let pass = passphrase.to_owned();
    let plain = tauri::async_runtime::spawn_blocking(move || open(&pass, &data)).await.map_err(|e| e.to_string())??;
    let bundle: Bundle = serde_json::from_slice(&plain).map_err(|e| format!("Sauvegarde illisible : {e}"))?;
    if bundle.version != 1 {
        return Err(format!("Format de sauvegarde {} non pris en charge : mettez l'application à jour", bundle.version));
    }
    merge(app, bundle).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_tamper() {
        // Paramètres réduits : les tests tournent sans optimisations.
        let sealed = seal_with("une phrase de passe solide", b"{\"version\":1}", 8 * 1024, 1, 1).unwrap();
        assert_eq!(open("une phrase de passe solide", &sealed).unwrap(), b"{\"version\":1}");
        assert!(open("mauvaise phrase de passe", &sealed).is_err());
        let mut altered = sealed.clone();
        // Paramètres de l'en-tête modifiés : refusés (authentifiés).
        altered[MAGIC.len() + 4] ^= 1;
        assert!(open("une phrase de passe solide", &altered).is_err());
        assert!(seal("court", b"x").is_err());
        assert!(open("x", b"pas une sauvegarde").is_err());
    }

    #[test]
    fn day_format() {
        let d = chrono_day();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
