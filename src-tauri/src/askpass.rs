//! Mots de passe et codes à usage unique (2FA) pour SSH, avec le client OpenSSH du système.
//!
//! OpenSSH appelle l'application elle-même comme programme `SSH_ASKPASS`. Ce processus
//! relaie l'invite à l'application par une connexion locale protégée par un jeton aléatoire.
//! L'application répond avec le mot de passe saisi dans le formulaire ou enregistré dans le
//! trousseau du système, ou bien demande à l'utilisateur (code 2FA, phrase secrète…).
//! Aucun secret ne passe par la ligne de commande, les variables d'environnement ou le disque.

use std::collections::HashMap;
use std::io::{BufRead, BufReader as StdBufReader, Write};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::ssh::SshHost;

const ENV_ADDR: &str = "MD_ASKPASS_ADDR";
const ENV_TOKEN: &str = "MD_ASKPASS_TOKEN";
const ENV_SESSION: &str = "MD_ASKPASS_SESSION";
const KEYRING_SERVICE: &str = "dev.r0mish.mistral-desktop";
/// Temps laissé à l'utilisateur pour répondre à une invite.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);
/// Durée de vie d'une session (le temps de l'authentification, largement).
const SESSION_TTL: Duration = Duration::from_secs(600);

type R<T> = Result<T, String>;

struct Server {
    addr: String,
    token: String,
}

static SERVER: OnceLock<Server> = OnceLock::new();

/// Une connexion ssh en cours d'authentification.
struct Session {
    host_id: String,
    label: String,
    /// Mot de passe saisi dans le formulaire (test de connexion), jamais écrit sur disque.
    secret: Option<String>,
    /// Noms du serveur attendu (en minuscules) : le mot de passe connu n'est donné qu'aux
    /// invites qui le mentionnent, jamais à un serveur de rebond (ProxyJump) par exemple.
    expect: Vec<String>,
    /// Le mot de passe connu a déjà été proposé : une nouvelle invite signifie qu'il est refusé.
    tried: bool,
    /// L'utilisateur a annulé : les invites suivantes de cette connexion sont refusées d'office.
    cancelled: bool,
    created: Instant,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(Default::default);
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<Option<Answer>>>>> = LazyLock::new(Default::default);

#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    session: String,
    prompt: String,
    confirm: bool,
}

#[derive(Serialize, Deserialize)]
struct Reply {
    answer: Option<String>,
}

/// Réponse de l'utilisateur à une invite.
pub struct Answer {
    pub text: String,
    /// Enregistrer ce mot de passe dans le trousseau.
    pub save: bool,
}

/// Invite affichée par l'interface (événement `ssh-prompt`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
    id: String,
    host_id: String,
    host: String,
    prompt: String,
    /// Invite de mot de passe (enregistrable), sinon code, phrase secrète…
    password: bool,
    /// Le mot de passe précédent a été refusé.
    retry: bool,
}

fn keyring_entry(host_id: &str) -> R<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ssh:{host_id}")).map_err(|e| e.to_string())
}

pub fn saved_password(host_id: &str) -> Option<String> {
    keyring_entry(host_id).ok()?.get_password().ok()
}

pub fn has_password(host_id: &str) -> bool {
    !host_id.is_empty() && saved_password(host_id).is_some()
}

pub fn save_password(host_id: &str, password: &str) -> R<()> {
    if host_id.is_empty() {
        return Err("Serveur non enregistré".into());
    }
    keyring_entry(host_id)?
        .set_password(password)
        .map_err(|e| format!("Trousseau du système indisponible : {e}"))
}

pub fn forget_password(host_id: &str) -> R<()> {
    match keyring_entry(host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Invite de mot de passe, par opposition à un code 2FA (« one-time password », « verification
/// code »…) ou à une phrase secrète de clé : seul un vrai mot de passe reçoit la valeur enregistrée.
fn is_password_prompt(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    let password = ["password", "mot de passe", "passwort", "contraseña"].iter().any(|w| p.contains(w));
    let other = ["passphrase", "one-time", "one time", "otp", "code", "token", "verification", "pin"].iter().any(|w| p.contains(w));
    password && !other
}

/// Démarre le relais local (au lancement de l'application).
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(e) => return eprintln!("askpass : écoute locale impossible : {e}"),
        };
        let Ok(addr) = listener.local_addr() else { return };
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let _ = SERVER.set(Server { addr: addr.to_string(), token });
        loop {
            let Ok((stream, peer)) = listener.accept().await else { continue };
            if !peer.ip().is_loopback() {
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle(app, stream).await;
            });
        }
    });
}

/// Variables d'environnement à donner à `ssh` pour un hôte authentifié par mot de passe.
pub fn env_for(h: &SshHost) -> Vec<(String, String)> {
    let Some(server) = SERVER.get() else { return Vec::new() };
    let Ok(exe) = std::env::current_exe() else { return Vec::new() };
    let session = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut sessions = SESSIONS.lock().unwrap();
        sessions.retain(|_, s| s.created.elapsed() < SESSION_TTL);
        sessions.insert(
            session.clone(),
            Session {
                host_id: h.id.clone(),
                label: if h.label.is_empty() { h.host.clone() } else { h.label.clone() },
                secret: h.secret.clone(),
                expect: [Some(h.host.clone()), crate::ssh::resolved_hostname(h)]
                    .into_iter()
                    .flatten()
                    .map(|n| n.rsplit('@').next().unwrap_or(&n).to_lowercase())
                    .collect(),
                tried: false,
                cancelled: false,
                created: Instant::now(),
            },
        );
    }
    let mut env = vec![
        ("SSH_ASKPASS".into(), exe.display().to_string()),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        (ENV_ADDR.into(), server.addr.clone()),
        (ENV_TOKEN.into(), server.token.clone()),
        (ENV_SESSION.into(), session),
    ];
    // OpenSSH < 8.4 (dont celui de Windows 10) ignore SSH_ASKPASS_REQUIRE et n'utilise
    // l'askpass que si DISPLAY est défini.
    if std::env::var_os("DISPLAY").is_none() {
        env.push(("DISPLAY".into(), ":0".into()));
    }
    env
}

/// Une invite relayée par le processus askpass.
async fn handle(app: AppHandle, stream: TcpStream) -> R<()> {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    BufReader::new(read.take(16 * 1024)).read_line(&mut line).await.map_err(|e| e.to_string())?;
    let req: Request = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let server = SERVER.get().ok_or("relais non démarré")?;
    if !constant_eq(req.token.as_bytes(), server.token.as_bytes()) {
        return Err("jeton invalide".into());
    }
    let answer = if req.confirm { None } else { answer(&app, &req.session, &req.prompt).await };
    let reply = serde_json::to_string(&Reply { answer }).unwrap_or_default();
    write.write_all(format!("{reply}\n").as_bytes()).await.map_err(|e| e.to_string())
}

async fn answer(app: &AppHandle, session: &str, prompt: &str) -> Option<String> {
    let password = is_password_prompt(prompt);
    let (host_id, label, known, retry) = {
        let mut sessions = SESSIONS.lock().unwrap();
        let s = sessions.get_mut(session)?;
        if s.cancelled {
            return None;
        }
        let retry = password && s.tried;
        let known = if password && !s.tried && names_host(prompt, &s.expect) {
            s.secret.clone().or_else(|| saved_password(&s.host_id))
        } else {
            None
        };
        s.tried |= known.is_some();
        (s.host_id.clone(), s.label.clone(), known, retry)
    };
    if let Some(p) = known {
        return Some(p);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap().insert(id.clone(), tx);
    let event = PromptEvent { id: id.clone(), host_id: host_id.clone(), host: label, prompt: prompt.trim().to_string(), password, retry };
    if app.emit("ssh-prompt", event).is_err() {
        PENDING.lock().unwrap().remove(&id);
        return None;
    }
    let reply = tokio::time::timeout(PROMPT_TIMEOUT, rx).await.ok().and_then(Result::ok).flatten();
    PENDING.lock().unwrap().remove(&id);
    if let Some(s) = SESSIONS.lock().unwrap().get_mut(session) {
        s.tried |= password;
        s.cancelled = reply.is_none();
    }
    let a = reply?;
    if password && a.save && !host_id.is_empty() {
        let _ = save_password(&host_id, &a.text);
    }
    Some(a.text)
}

/// Réponse de l'interface à une invite (`None` : annulée).
pub fn respond(id: &str, answer: Option<Answer>) {
    if let Some(tx) = PENDING.lock().unwrap().remove(id) {
        let _ = tx.send(answer);
    }
}

/// L'invite d'OpenSSH nomme le serveur : « user@hôte's password: » ou « (user@hôte) Password: ».
fn names_host(prompt: &str, expect: &[String]) -> bool {
    let p = prompt.to_lowercase();
    expect.iter().any(|h| {
        let at = format!("@{h}");
        p.match_indices(&at).any(|(i, _)| {
            // Le nom doit être complet : « @srv » ne correspond pas à « @srv2 ».
            let next = p[i + at.len()..].chars().next();
            !next.is_some_and(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_')
        })
    })
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Mode askpass : l'exécutable est lancé par `ssh` pour obtenir un mot de passe.
/// Renvoie le code de sortie, ou `None` en fonctionnement normal.
pub fn client_main() -> Option<i32> {
    let addr = std::env::var(ENV_ADDR).ok()?;
    let request = Request {
        token: std::env::var(ENV_TOKEN).unwrap_or_default(),
        session: std::env::var(ENV_SESSION).unwrap_or_default(),
        prompt: std::env::args().nth(1).unwrap_or_default(),
        confirm: std::env::var("SSH_ASKPASS_PROMPT").is_ok_and(|v| v == "confirm"),
    };
    let ask = || -> std::io::Result<Option<String>> {
        let mut stream = std::net::TcpStream::connect_timeout(&addr.parse().map_err(std::io::Error::other)?, Duration::from_secs(5))?;
        stream.set_read_timeout(Some(PROMPT_TIMEOUT + Duration::from_secs(10)))?;
        stream.write_all(format!("{}\n", serde_json::to_string(&request)?).as_bytes())?;
        let mut line = String::new();
        StdBufReader::new(stream).read_line(&mut line)?;
        Ok(serde_json::from_str::<Reply>(&line)?.answer)
    };
    match ask() {
        Ok(Some(answer)) => {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
            Some(0)
        }
        _ => Some(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_prompts_are_recognised() {
        assert!(is_password_prompt("admin@srv's password: "));
        assert!(is_password_prompt("Password:"));
        assert!(is_password_prompt("(admin@srv) Password: "));
        assert!(!is_password_prompt("Verification code: "));
        assert!(!is_password_prompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': "));
        assert!(!is_password_prompt("One-time password (OATH) for `admin': "));
        assert!(!is_password_prompt("Enter your PIN: "));
    }

    /// Nécessite un trousseau (Secret Service, Keychain, Credential Manager) : `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn keyring_round_trip() {
        let id = format!("test-{}", uuid::Uuid::new_v4().simple());
        save_password(&id, "s3cret").unwrap();
        assert!(has_password(&id));
        assert_eq!(saved_password(&id).as_deref(), Some("s3cret"));
        forget_password(&id).unwrap();
        assert!(!has_password(&id));
    }

    #[test]
    fn saved_password_only_for_the_expected_server() {
        let expect = vec!["srv.example.org".to_string(), "10.0.0.5".to_string()];
        assert!(names_host("admin@srv.example.org's password: ", &expect));
        assert!(names_host("(admin@10.0.0.5) Password: ", &expect));
        assert!(names_host("(admin@SRV.example.org) Password: ", &expect));
        // Serveur de rebond, nom voisin, invite anonyme : on demande à l'utilisateur.
        assert!(!names_host("admin@bastion.example.org's password: ", &expect));
        assert!(!names_host("admin@10.0.0.50's password: ", &expect));
        assert!(!names_host("admin@srv.example.org.evil.net's password: ", &expect));
        assert!(!names_host("Password: ", &expect));
    }

    #[test]
    fn token_comparison() {
        assert!(constant_eq(b"abc", b"abc"));
        assert!(!constant_eq(b"abc", b"abd"));
        assert!(!constant_eq(b"abc", b"ab"));
    }
}
