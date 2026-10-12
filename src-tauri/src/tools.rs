//! Registre des outils proposés au modèle et exécution des appels.
//! L'interface décide de l'approbation selon le niveau de risque renvoyé ici.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Notify;

use crate::mcp::McpManager;
use crate::storage::Settings;
use crate::ssh::SshHost;
use crate::target::Target;
use crate::{git, mistral, web};

type R<T> = Result<T, String>;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolContext {
    /// Dossier de projet (mode Code).
    pub workspace: Option<String>,
    #[serde(default)]
    pub web: bool,
    #[serde(default)]
    pub mcp: bool,
}

#[derive(Serialize)]
pub struct ToolDef {
    pub definition: Value,
    /// read | write | exec | mcp
    pub risk: &'static str,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    pub content: String,
    pub is_error: bool,
    /// Diff unifié à afficher dans l'interface (écritures de fichiers).
    pub diff: Option<String>,
}

fn func(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required },
        }
    })
}

pub fn definitions(ctx: &ToolContext, mcp: &McpManager, shell: &crate::shell::Shell) -> Vec<ToolDef> {
    let remote = ctx.workspace.as_deref().and_then(crate::target::parse_remote).is_some();
    let (shell_name, shell_hint) = if remote {
        ("bash sur le serveur distant (SSH)".to_string(), "Commands run on the remote server over SSH: use bash/POSIX syntax.")
    } else {
        (shell.name.clone(), crate::shell::guidance(shell))
    };
    let mut out = Vec::new();
    if ctx.web {
        out.push(ToolDef {
            risk: "read",
            definition: func(
                "web_search",
                "Recherche sur le web. À utiliser pour toute information récente, factuelle ou que tu ne connais pas avec certitude. Cite ensuite les sources sous forme de liens Markdown.",
                json!({ "query": { "type": "string", "description": "Requête de recherche, concise" } }),
                &["query"],
            ),
        });
        out.push(ToolDef {
            risk: "read",
            definition: func(
                "fetch_url",
                "Télécharge une page web publique et renvoie son texte. Utile pour lire en détail un résultat de recherche ou une URL donnée par l'utilisateur.",
                json!({
                    "url": { "type": "string" },
                    "max_chars": { "type": "integer", "description": "Taille max du texte renvoyé (défaut 20000)" }
                }),
                &["url"],
            ),
        });
    }
    if ctx.workspace.is_some() {
        out.extend([
            ToolDef {
                risk: "read",
                definition: func(
                    "list_files",
                    "Liste les fichiers et dossiers du projet (respecte .gitignore). Les dossiers finissent par /.",
                    json!({
                        "path": { "type": "string", "description": "Dossier relatif à la racine du projet (défaut « . »)" },
                        "depth": { "type": "integer", "description": "Profondeur, de 1 à 6 (défaut 2)" }
                    }),
                    &[],
                ),
            },
            ToolDef {
                risk: "read",
                definition: func(
                    "read_file",
                    "Lit un fichier texte du projet. Le résultat est numéroté (numéro<TAB>contenu) ; les numéros ne font pas partie du fichier.",
                    json!({
                        "path": { "type": "string" },
                        "offset": { "type": "integer", "description": "Première ligne à lire (1 = début)" },
                        "limit": { "type": "integer", "description": "Nombre de lignes (max 2000)" }
                    }),
                    &["path"],
                ),
            },
            ToolDef {
                risk: "read",
                definition: func(
                    "search_files",
                    "Recherche une expression régulière (syntaxe Rust regex) dans les fichiers du projet. Renvoie chemin:ligne: contenu.",
                    json!({
                        "pattern": { "type": "string" },
                        "path": { "type": "string", "description": "Sous-dossier où chercher (défaut « . »)" },
                        "glob": { "type": "string", "description": "Filtre de fichiers, ex. « *.ts » ou « src/**/*.rs »" }
                    }),
                    &["pattern"],
                ),
            },
            ToolDef {
                risk: "write",
                definition: func(
                    "write_file",
                    "Crée ou remplace entièrement un fichier. Pour modifier un fichier existant, préfère edit_file.",
                    json!({ "path": { "type": "string" }, "content": { "type": "string" } }),
                    &["path", "content"],
                ),
            },
            ToolDef {
                risk: "write",
                definition: func(
                    "edit_file",
                    "Remplace un passage exact d'un fichier. old_string doit correspondre exactement (espaces et indentation compris, sans les numéros de ligne) et être unique, sauf si replace_all=true. Lis le fichier avant de le modifier.",
                    json!({
                        "path": { "type": "string" },
                        "old_string": { "type": "string" },
                        "new_string": { "type": "string" },
                        "replace_all": { "type": "boolean" }
                    }),
                    &["path", "old_string", "new_string"],
                ),
            },
            ToolDef {
                risk: "exec",
                definition: func(
                    "run_command",
                    &format!(
                        "Exécute une commande dans la racine du projet (tests, build, git, linters…). Shell : {}. {} Non interactive : stdin est fermé. Sortie limitée à 30 000 caractères.",
                        shell_name,
                        shell_hint
                    ),
                    json!({
                        "command": { "type": "string" },
                        "timeout_seconds": { "type": "integer", "description": "Délai maximal (défaut : réglage de l'application)" }
                    }),
                    &["command"],
                ),
            },
            ToolDef {
                risk: "read",
                definition: func(
                    "git_status",
                    "État git du projet : branche, avance/retard sur la branche distante, fichiers modifiés (format porcelain XY).",
                    json!({}),
                    &[],
                ),
            },
            ToolDef {
                risk: "read",
                definition: func(
                    "git_diff",
                    "Différences git non commitées (ou indexées si staged=true), pour tout le dépôt ou un fichier.",
                    json!({
                        "path": { "type": "string", "description": "Fichier à comparer (défaut : tout le dépôt)" },
                        "staged": { "type": "boolean", "description": "Comparer l'index au lieu de l'arbre de travail" }
                    }),
                    &[],
                ),
            },
            ToolDef {
                risk: "read",
                definition: func(
                    "git_log",
                    "Derniers commits (hash court, sujet, auteur, date).",
                    json!({ "count": { "type": "integer", "description": "Nombre de commits (défaut 15)" } }),
                    &[],
                ),
            },
        ]);
    }
    if ctx.mcp {
        out.extend(mcp.tool_definitions().into_iter().map(|definition| ToolDef { definition, risk: "mcp" }));
    }
    out
}

fn parse_args(arguments: &str) -> R<Map<String, Value>> {
    let v: Value = serde_json::from_str(if arguments.trim().is_empty() { "{}" } else { arguments })
        .map_err(|e| format!("Arguments JSON invalides : {e}"))?;
    match v {
        Value::Object(m) => Ok(m),
        _ => Err("Les arguments doivent être un objet JSON".into()),
    }
}

fn s<'a>(args: &'a Map<String, Value>, key: &str) -> R<&'a str> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("Argument manquant : {key}"))
}

fn opt_s<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn opt_u(args: &Map<String, Value>, key: &str) -> Option<usize> {
    args.get(key).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).map(|n| n as usize)
}

fn flag(args: &Map<String, Value>, key: &str) -> bool {
    args.get(key).is_some_and(|v| v.as_bool().unwrap_or(v.as_str() == Some("true")))
}

/// Dossier de projet du contexte (local ou SSH), uniquement s'il a été autorisé
/// (boîte de dialogue native ou connexion SSH validée).
fn root(ctx: &ToolContext, approved: &[String], hosts: &[SshHost]) -> R<Target> {
    let ws = ctx.workspace.as_deref().ok_or("Aucun dossier de projet associé à cette conversation")?;
    crate::target::resolve(ws, approved, hosts)
}

/// Diff prévisionnel d'une écriture, pour la demande d'approbation.
pub async fn preview(ctx: &ToolContext, approved: &[String], hosts: &[SshHost], name: &str, arguments: &str) -> R<Option<String>> {
    let args = parse_args(arguments)?;
    match name {
        "write_file" => Ok(Some(root(ctx, approved, hosts)?.preview_write(s(&args, "path")?, s(&args, "content")?).await?)),
        "edit_file" => Ok(Some(
            root(ctx, approved, hosts)?
                .preview_edit(s(&args, "path")?, s(&args, "old_string")?, s(&args, "new_string")?, flag(&args, "replace_all"))
                .await?,
        )),
        _ => Ok(None),
    }
}

pub struct RunEnv<'a> {
    pub settings: &'a Settings,
    pub api_key: R<String>,
    pub approved: &'a [String],
    pub hosts: &'a [SshHost],
    pub mcp: &'a McpManager,
    pub cancel: Arc<Notify>,
}

pub async fn run(ctx: &ToolContext, env: RunEnv<'_>, name: &str, arguments: &str) -> ToolOutput {
    match run_inner(ctx, env, name, arguments).await {
        Ok(o) => o,
        Err(e) => ToolOutput { content: format!("Erreur : {e}"), is_error: true, diff: None },
    }
}

async fn run_inner(ctx: &ToolContext, env: RunEnv<'_>, name: &str, arguments: &str) -> R<ToolOutput> {
    let args = parse_args(arguments)?;
    let text = |content: String| ToolOutput { content, ..Default::default() };
    let target = || root(ctx, env.approved, env.hosts);
    match name {
        "web_search" => {
            let q = s(&args, "query")?;
            let out = match env.settings.web_search_provider.as_str() {
                "searxng" => web::searxng(&env.settings.searxng_url, q).await?,
                _ => mistral::web_search(&env.settings.base_url, &env.api_key?, q).await?,
            };
            Ok(text(out))
        }
        "fetch_url" => Ok(text(web::fetch_url(s(&args, "url")?, opt_u(&args, "max_chars").unwrap_or(20_000).clamp(1000, 100_000)).await?)),
        "list_files" => Ok(text(target()?.list_files(opt_s(&args, "path").unwrap_or("."), opt_u(&args, "depth").unwrap_or(2)).await?)),
        "read_file" => Ok(text(target()?.read_file(s(&args, "path")?, opt_u(&args, "offset"), opt_u(&args, "limit")).await?)),
        "search_files" => Ok(text(target()?.search(s(&args, "pattern")?, opt_s(&args, "path").unwrap_or("."), opt_s(&args, "glob")).await?)),
        "write_file" => {
            let (msg, diff) = target()?.write_file(s(&args, "path")?, s(&args, "content")?).await?;
            Ok(ToolOutput { content: msg, is_error: false, diff: Some(diff) })
        }
        "edit_file" => {
            let (msg, diff) = target()?
                .edit_file(s(&args, "path")?, s(&args, "old_string")?, s(&args, "new_string")?, flag(&args, "replace_all"))
                .await?;
            Ok(ToolOutput { content: msg, is_error: false, diff: Some(diff) })
        }
        "run_command" => {
            let timeout = opt_u(&args, "timeout_seconds").map(|t| t as u64).unwrap_or(env.settings.command_timeout);
            let sh = crate::shell::detect(&env.settings.shell);
            Ok(text(target()?.run_command(&sh, s(&args, "command")?, timeout, env.cancel).await?))
        }
        "git_status" => Ok(text(git::status_text(&git::status(&target()?).await?))),
        "git_diff" => {
            let out = git::diff(&target()?, opt_s(&args, "path"), flag(&args, "staged"), false).await?;
            Ok(text(if out.trim().is_empty() { "Aucune différence.".into() } else { out }))
        }
        "git_log" => {
            let commits = git::log(&target()?, opt_u(&args, "count").unwrap_or(15) as u32).await?;
            Ok(text(if commits.is_empty() {
                "Aucun commit.".into()
            } else {
                commits.iter().map(|c| format!("{} {} ({}, {})", c.hash, c.subject, c.author, c.date)).collect::<Vec<_>>().join("\n")
            }))
        }
        n if n.starts_with("mcp_") => {
            let (content, is_error) = env.mcp.call(n, args).await?;
            Ok(ToolOutput { content, is_error, diff: None })
        }
        other => Err(format!("Outil inconnu : {other}")),
    }
}
