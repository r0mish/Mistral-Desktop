// Gestion des serveurs SSH : création, test, confiance, choix d'un dossier distant.
import { listen } from "@tauri-apps/api/event";
import { api, type SshHost, type SshPrompt } from "./api";
import { escapeHtml } from "./markdown";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let hosts: SshHost[] = [];
let current: SshHost | null = null;
let browsePath = "";
let onOpen: (workspace: string) => void = () => {};
/** Choix d'un dossier pour un autre écran (projet) au lieu d'ouvrir une session. */
let onPick: ((workspace: string) => void) | null = null;
let notify: (msg: string, error?: boolean) => void = () => {};

const dlg = () => $<HTMLDialogElement>("#ssh-dialog");
const f = {
  label: () => $<HTMLInputElement>("#ssh-label"),
  host: () => $<HTMLInputElement>("#ssh-host"),
  user: () => $<HTMLInputElement>("#ssh-user"),
  port: () => $<HTMLInputElement>("#ssh-port"),
  key: () => $<HTMLInputElement>("#ssh-key"),
  auth: () => $<HTMLSelectElement>("#ssh-auth"),
  password: () => $<HTMLInputElement>("#ssh-password"),
  savePassword: () => $<HTMLInputElement>("#ssh-save-password"),
};

const usesPassword = () => f.auth().value === "password";

const errMsg = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

export const sshHosts = () => hosts;

export async function loadHosts() {
  hosts = await api.sshHosts().catch(() => []);
  return hosts;
}

/** `ssh:<id>:<chemin>` → { host, path } */
export function parseRemote(ws: string | undefined | null): { host: SshHost | null; hostId: string; path: string } | null {
  const m = ws?.match(/^ssh:([^:]+):(\/.*)$/);
  if (!m) return null;
  return { host: hosts.find((h) => h.id === m[1]) ?? null, hostId: m[1], path: m[2] };
}

export function workspaceLabel(ws: string): { name: string; detail: string; remote: boolean } {
  const r = parseRemote(ws);
  if (r) {
    const base = r.path.split("/").filter(Boolean).pop() ?? "/";
    const host = r.host?.label ?? "serveur supprimé";
    return { name: `${host} : ${base}`, detail: `${r.host?.host ?? "?"}:${r.path}`, remote: true };
  }
  // Préfixe interne `\\?\` enregistré par d'anciennes versions sous Windows.
  const path = ws.replace(/^\\\\\?\\(?=[A-Za-z]:)/, "");
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return { name: base, detail: path, remote: false };
}

function formHost(): SshHost {
  const port = Number(f.port().value);
  return {
    id: current?.id ?? "",
    label: f.label().value.trim(),
    host: f.host().value.trim(),
    user: f.user().value.trim() || null,
    port: port > 0 ? port : null,
    identityFile: usesPassword() ? null : f.key().value.trim() || null,
    system: current?.system ?? null,
    auth: usesPassword() ? "password" : null,
  };
}

function renderList() {
  $("#ssh-host-list").innerHTML =
    hosts
      .map(
        (h) => `<button type="button" class="ssh-host${current?.id === h.id ? " active" : ""}" data-host="${escapeHtml(h.id)}">
          <strong>${escapeHtml(h.label)}</strong><small>${escapeHtml(h.user ? `${h.user}@` : "")}${escapeHtml(h.host)}${h.port ? `:${h.port}` : ""}</small></button>`,
      )
      .join("") || '<p class="muted small">Aucun serveur enregistré.</p>';
}

function select(h: SshHost | null) {
  current = h;
  $("#ssh-title").textContent = h ? h.label : "Nouveau serveur";
  f.label().value = h?.label ?? "";
  f.host().value = h?.host ?? "";
  f.user().value = h?.user ?? "";
  f.port().value = h?.port ? String(h.port) : "";
  f.key().value = h?.identityFile ?? "";
  f.auth().value = h?.auth === "password" ? "password" : "key";
  f.password().value = "";
  f.savePassword().checked = true;
  $("#ssh-password-status").textContent = h?.hasPassword ? "✓ Mot de passe enregistré : laissez le champ vide pour le conserver." : "";
  renderAuth();
  $("#ssh-delete").hidden = !h;
  $("#ssh-result").innerHTML = "";
  $("#ssh-browser").hidden = true;
  renderList();
}

function renderAuth() {
  document.querySelectorAll<HTMLElement>("#ssh-form [data-auth]").forEach((e) => (e.hidden = e.dataset.auth !== f.auth().value));
}

/** Après une connexion réussie : mot de passe enregistré, conservé ou oublié selon le formulaire. */
async function storePassword(saved: SshHost, typed: string) {
  if (saved.auth !== "password") {
    if (current?.hasPassword) await api.sshSetPassword(saved.id, null);
    return;
  }
  if (!f.savePassword().checked) await api.sshSetPassword(saved.id, null);
  else if (typed) await api.sshSetPassword(saved.id, typed);
}

function showResult(html: string, kind: "ok" | "error" | "warn" | "info") {
  $("#ssh-result").innerHTML = `<div class="ssh-msg ${kind}">${html}</div>`;
}

async function connect() {
  const host = formHost();
  if (!host.host) return;
  showResult('<span class="spinner"></span> Connexion…', "info");
  $("#ssh-browser").hidden = true;
  try {
    const typed = usesPassword() ? f.password().value : "";
    const res = await api.sshTest(host, typed);
    if (res.needsTrust) {
      const fps = res.fingerprints.length
        ? `<ul class="fps">${res.fingerprints.map((x) => `<li><code>${escapeHtml(x)}</code></li>`).join("")}</ul>`
        : "<p>Empreinte non récupérable directement (rebond ProxyJump ?) : elle sera enregistrée à la première connexion.</p>";
      showResult(
        `<strong>Hôte inconnu.</strong> Vérifiez que l'empreinte correspond à celle du serveur (<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> sur le serveur) avant de lui faire confiance.${fps}
         <div class="row end"><button type="button" class="btn-primary sm" id="ssh-trust">Faire confiance et continuer</button></div>`,
        "warn",
      );
      $("#ssh-trust").addEventListener("click", async () => {
        try {
          await api.sshTrust(host, typed);
          await connect();
        } catch (e) {
          showResult(escapeHtml(errMsg(e)), "error");
        }
      });
      return;
    }
    if (!res.ok) return showResult(escapeHtml(res.error ?? "Échec de la connexion"), "error");
    // Connexion réussie : on enregistre le serveur (avec le système détecté).
    const saved = await api.sshSaveHost({ ...host, system: res.system });
    await storePassword(saved, typed).catch((e) => notify(`Mot de passe non enregistré : ${errMsg(e)}`, true));
    f.password().value = "";
    await loadHosts();
    current = hosts.find((h) => h.id === saved.id) ?? saved;
    renderList();
    $("#ssh-title").textContent = saved.label;
    $("#ssh-delete").hidden = false;
    showResult(
      `✓ Connecté en tant que <strong>${escapeHtml(res.user ?? "?")}</strong> — ${escapeHtml(res.system ?? "système inconnu")}${
        res.git ? ` — ${escapeHtml(res.git)}` : " — <em>git absent sur le serveur</em>"
      }`,
      "ok",
    );
    await browse(browsePath && current?.id === saved.id ? browsePath : res.home ?? "");
  } catch (e) {
    showResult(escapeHtml(errMsg(e)), "error");
  }
}

async function browse(path: string) {
  if (!current) return;
  const box = $("#ssh-dirs");
  box.innerHTML = '<p class="muted small"><span class="spinner"></span> Lecture…</p>';
  $("#ssh-browser").hidden = false;
  try {
    const l = await api.sshListDirs(current.id, path);
    browsePath = l.path;
    $<HTMLInputElement>("#ssh-path").value = l.path;
    const up = l.path === "/" ? "" : `<button type="button" class="ssh-dir" data-dir="..">⬑ ..</button>`;
    box.innerHTML =
      up +
      (l.dirs.map((d) => `<button type="button" class="ssh-dir" data-dir="${escapeHtml(d)}">📁 ${escapeHtml(d)}</button>`).join("") ||
        '<p class="muted small">Aucun sous-dossier.</p>');
  } catch (e) {
    box.innerHTML = `<p class="error">${escapeHtml(errMsg(e))}</p>`;
  }
}

export function openSshDialog(pick?: (workspace: string) => void) {
  onPick = pick ?? null;
  $("#ssh-open").textContent = pick ? "Choisir ce dossier" : "Ouvrir ce dossier";
  select(hosts[0] ?? null);
  dlg().showModal();
}

export function initSshUi(opts: { onOpen: (ws: string) => void; toast: (msg: string, error?: boolean) => void }) {
  onOpen = opts.onOpen;
  notify = opts.toast;
  $("#ssh-close").addEventListener("click", () => dlg().close());
  f.auth().addEventListener("change", renderAuth);
  initPrompts();
  dlg().addEventListener("close", () => (onPick = null));
  $("#ssh-new").addEventListener("click", () => select(null));
  $("#ssh-host-list").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-host]")?.dataset.host;
    const h = hosts.find((x) => x.id === id);
    if (h) {
      browsePath = "";
      select(h);
    }
  });
  $("#ssh-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connect();
  });
  $("#ssh-delete").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLElement;
    if (!current) return;
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.textContent = "Confirmer la suppression";
      setTimeout(() => {
        btn.classList.remove("confirm");
        btn.textContent = "Supprimer";
      }, 3000);
      return;
    }
    await api.sshDeleteHost(current.id).catch((err) => notify(errMsg(err), true));
    await loadHosts();
    select(hosts[0] ?? null);
  });
  $("#ssh-dirs").addEventListener("click", (e) => {
    const d = (e.target as HTMLElement).closest<HTMLElement>("[data-dir]")?.dataset.dir;
    if (!d) return;
    const next = d === ".." ? browsePath.replace(/\/[^/]*\/?$/, "") || "/" : `${browsePath.replace(/\/$/, "")}/${d}`;
    browse(next);
  });
  $("#ssh-go").addEventListener("click", () => browse($<HTMLInputElement>("#ssh-path").value));
  $<HTMLInputElement>("#ssh-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      browse($<HTMLInputElement>("#ssh-path").value);
    }
  });
  $("#ssh-open").addEventListener("click", async () => {
    if (!current) return;
    try {
      const ws = await api.sshOpenWorkspace(current.id, browsePath);
      const pick = onPick;
      dlg().close();
      (pick ?? onOpen)(ws);
    } catch (e) {
      notify(errMsg(e), true);
    }
  });
  loadHosts();
}

// ---------------------------------------------------------------- invites (mot de passe, code 2FA)

const prompts: SshPrompt[] = [];
let shown: SshPrompt | null = null;
const promptDlg = () => $<HTMLDialogElement>("#ssh-prompt");

/** Affiche l'invite suivante, une à la fois. */
function nextPrompt() {
  if (shown || !prompts.length) return;
  shown = prompts.shift()!;
  $("#ssh-prompt-title").textContent = `Connexion SSH : ${shown.host}`;
  $("#ssh-prompt-text").textContent = shown.prompt || "Mot de passe :";
  $("#ssh-prompt-retry").hidden = !shown.retry;
  $("#ssh-prompt-save-row").hidden = !shown.password || !shown.hostId;
  $<HTMLInputElement>("#ssh-prompt-save").checked = false;
  const input = $<HTMLInputElement>("#ssh-prompt-input");
  input.value = "";
  promptDlg().showModal();
  input.focus();
}

function answerPrompt(answer: string | null) {
  const p = shown;
  if (!p) return;
  shown = null;
  const save = answer !== null && $<HTMLInputElement>("#ssh-prompt-save").checked;
  $<HTMLInputElement>("#ssh-prompt-input").value = "";
  api.sshPromptAnswer(p.id, answer, save).catch(() => {});
  if (promptDlg().open) promptDlg().close();
  // Mot de passe enregistré : l'indication du formulaire SSH est mise à jour (sans le réinitialiser).
  if (save) {
    loadHosts().then(() => {
      if (current?.id !== p.hostId) return;
      current = hosts.find((h) => h.id === p.hostId) ?? current;
      $("#ssh-password-status").textContent = "✓ Mot de passe enregistré : laissez le champ vide pour le conserver.";
    });
  }
  setTimeout(nextPrompt, 50);
}

function initPrompts() {
  listen<SshPrompt>("ssh-prompt", (e) => {
    prompts.push(e.payload);
    nextPrompt();
  });
  $("#ssh-prompt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    answerPrompt($<HTMLInputElement>("#ssh-prompt-input").value);
  });
  $("#ssh-prompt-cancel").addEventListener("click", () => answerPrompt(null));
  promptDlg().addEventListener("close", () => answerPrompt(null));
}
