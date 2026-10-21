// Barre du haut et compositeur : options de la conversation, consignes AGENTS.md, choix du dossier.
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type InstructionFile, type PermissionMode } from "./api";
import { escapeHtml } from "./markdown";
import { openSshDialog, parseRemote, workspaceLabel } from "./ssh-ui";
import { scheduleGitRefresh, toggleGitPanel } from "./git-ui";
import { findProject, projectList } from "./projects-ui";
import { el, errMsg, opts, state, type Draft } from "./state";
import { copy, icons, toast } from "./ui";
import { newChat, projectOptions } from "./sidebar";
import { renderConversation, renderWelcome } from "./thread";
import { renderActivity, renderUsage, saveCurrent } from "./run";

// ---------------------------------------------------------------- options de la conversation


export function setOpt<K extends keyof Draft>(key: K, value: Draft[K]) {
  if (state.current) {
    (state.current as unknown as Draft)[key] = value;
    saveCurrent();
  } else {
    state.draft[key] = value;
  }
  renderChrome();
}

const mcpToolCount = () => state.mcp.filter((s) => s.state === "ready").reduce((n, s) => n + s.tools.length, 0);

/** Barre du haut et bascules du compositeur. */
export function renderChrome() {
  const c = state.current;
  const o = opts();
  el.title.textContent = c?.title ?? (o.kind === "code" ? "Nouvelle session de code" : "Nouvelle conversation");
  el.exportBtn.hidden = !c;
  el.wsChip.hidden = o.kind !== "code" || !o.workspace;
  if (o.workspace) {
    const l = workspaceLabel(o.workspace);
    el.wsChip.querySelector("span")!.textContent = l.name;
    el.wsChip.title = l.remote ? `${l.detail}\nCliquer pour copier le chemin` : `${l.detail}\nCliquer pour ouvrir le dossier`;
    el.wsChip.classList.toggle("remote", l.remote);
  }
  renderInstrChip(o.kind === "code" ? o.workspace : undefined);
  renderWsPicker();
  const projects = projectList();
  el.convProject.hidden = projects.length === 0;
  if (projects.length) {
    el.convProject.innerHTML = projectOptions("Sans projet");
    el.convProject.value = o.projectId && findProject(o.projectId) ? o.projectId : "";
    el.convProject.classList.toggle("on", !!el.convProject.value);
  }
  if (o.kind !== "code" || !o.workspace) toggleGitPanel(false);
  if (o.kind === "code") scheduleGitRefresh(200);
  else el.gitBtn.hidden = true;
  el.permSelect.hidden = o.kind !== "code";
  el.permSelect.value = o.permissionMode;
  el.webToggle.classList.toggle("on", o.webSearch);
  const configured = state.mcp.filter((s) => s.state !== "disabled").length;
  el.mcpToggle.hidden = configured === 0;
  el.mcpToggle.classList.toggle("on", o.mcp);
  el.sysToggle.hidden = o.kind !== "code";
  el.sysToggle.classList.toggle("on", o.systemAccess);
  el.mcpToggle.querySelector("span")!.textContent = `MCP ${mcpToolCount()}`;
  el.mcpToggle.title = state.mcp.map((s) => `${s.name} : ${s.state === "ready" ? `${s.tools.length} outils` : s.state}`).join("\n");
  el.input.placeholder = o.kind === "code" ? "Décrivez la tâche à réaliser dans le projet…" : "Écrivez à Mistral…";
  updateComposerState();
  renderUsage();
  renderActivity();
}

el.webToggle.addEventListener("click", () => setOpt("webSearch", !opts().webSearch));
el.mcpToggle.addEventListener("click", () => setOpt("mcp", !opts().mcp));
el.sysToggle.addEventListener("click", () => {
  const on = !opts().systemAccess;
  setOpt("systemAccess", on);
  if (on) toast("Accès système activé : l'agent peut lire et modifier des fichiers hors du projet, avec votre approbation.");
});
el.permSelect.addEventListener("change", () => setOpt("permissionMode", el.permSelect.value as PermissionMode));
el.wsChip.addEventListener("click", () => {
  const ws = opts().workspace;
  if (!ws) return;
  const r = parseRemote(ws);
  if (r) {
    copy(r.path);
    toast(`Chemin copié : ${r.path}`);
  } else {
    revealItemInDir(ws).catch((e) => toast(errMsg(e), true));
  }
});

const instrLoading = new Set<string>();

/** (Re)lit les fichiers de consignes du dossier. */
export async function loadInstructions(ws: string): Promise<InstructionFile[]> {
  instrLoading.add(ws);
  try {
    const files = await api.workspaceInstructions(ws).catch(() => [] as InstructionFile[]);
    state.instructions.set(ws, files);
    return files;
  } finally {
    instrLoading.delete(ws);
    if (opts().kind === "code" && opts().workspace === ws) {
      renderInstrChip(ws);
      if (!state.current) renderWelcome();
      else renderUsage();
    }
  }
}

function renderInstrChip(ws: string | undefined) {
  const files = ws ? state.instructions.get(ws) : undefined;
  if (ws && !files && !instrLoading.has(ws)) loadInstructions(ws);
  el.instrChip.hidden = !files?.length;
  if (!ws || !files?.length) return;
  el.instrChip.querySelector("span")!.textContent = files.map((f) => f.name).join(" + ");
  el.instrChip.title =
    "Consignes du projet lues automatiquement par l'agent à chaque tâche :\n" +
    files.map((f) => `• ${f.name} (${(f.content.length / 1024).toFixed(1)} Ko${f.truncated ? ", tronqué" : ""})`).join("\n") +
    (parseRemote(ws) ? "" : "\nCliquer pour afficher le fichier");
}

el.instrChip.addEventListener("click", () => {
  const ws = opts().workspace;
  const f = ws ? state.instructions.get(ws)?.[0] : undefined;
  if (!ws || !f || parseRemote(ws)) return;
  const sep = ws.includes("\\") && !ws.includes("/") ? "\\" : "/";
  revealItemInDir(`${ws.replace(/[\\/]$/, "")}${sep}${f.name}`).catch((e) => toast(errMsg(e), true));
});

export function selectWorkspace(ws: string) {
  toggleWsMenu(false);
  state.draft.workspace = ws;
  api
    .touchWorkspace(ws)
    .then(() => api.listWorkspaces())
    .then((w) => (state.workspaces = w))
    .catch(() => {});
  renderConversation();
  el.input.focus();
}

/** Bouton « dossier » de la zone de saisie (nouvelle session de code uniquement). */
function renderWsPicker() {
  const show = !state.current && state.mode === "code";
  el.wsPicker.hidden = !show;
  if (!show) return toggleWsMenu(false);
  const ws = state.draft.workspace;
  const l = ws ? workspaceLabel(ws) : null;
  el.wsPicker.querySelector("span")!.textContent = l ? l.name : "Choisir un dossier";
  el.wsPicker.classList.toggle("on", !!ws);
  el.wsPicker.classList.toggle("remote", !!l?.remote);
  el.wsPicker.title = l ? `${l.detail}\nCliquer pour changer de dossier` : "Choisir le dossier de travail : local ou serveur SSH";
}

export function toggleWsMenu(open = el.wsMenu.hidden) {
  if (!open) {
    el.wsMenu.hidden = true;
    return;
  }
  const cur = state.draft.workspace;
  const recent = state.workspaces
    .slice(0, 8)
    .map((w) => {
      const l = workspaceLabel(w);
      return `<button type="button" class="ws-menu-item${w === cur ? " current" : ""}" data-ws="${escapeHtml(w)}" title="${escapeHtml(l.detail)}">${l.remote ? icons.server : icons.folder}<span>${escapeHtml(l.name)}</span><small>${escapeHtml(l.detail)}</small></button>`;
    })
    .join("");
  el.wsMenu.innerHTML = `${recent ? `<div class="group">Dossiers récents</div>${recent}<hr />` : ""}
    <button type="button" class="ws-menu-item action" data-pick-ws>${icons.folder}<span>Ouvrir un dossier local…</span></button>
    <button type="button" class="ws-menu-item action" data-ssh>${icons.server}<span>Dossier sur un serveur SSH…</span></button>`;
  el.wsMenu.hidden = false;
}

el.wsPicker.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleWsMenu();
});
el.wsMenu.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const ws = t.closest<HTMLElement>("[data-ws]")?.dataset.ws;
  if (ws) return selectWorkspace(ws);
  if (t.closest("[data-pick-ws]")) {
    toggleWsMenu(false);
    return chooseWorkspace();
  }
  if (t.closest("[data-ssh]")) {
    toggleWsMenu(false);
    return openSshDialog();
  }
});
document.addEventListener("click", (e) => {
  if (!el.wsMenu.hidden && !(e.target as HTMLElement).closest("#ws-menu, #ws-picker")) toggleWsMenu(false);
});

export function openRemoteWorkspace(ws: string) {
  api.listWorkspaces().then((w) => (state.workspaces = w)).catch(() => {});
  if (state.current) newChat();
  state.draft.workspace = ws;
  renderConversation();
  el.input.focus();
}

export async function chooseWorkspace() {
  try {
    const path = await api.pickWorkspace();
    if (!path) return;
    state.workspaces = await api.listWorkspaces();
    state.draft.workspace = path;
    renderConversation();
    el.input.focus();
  } catch (e) {
    toast(errMsg(e), true);
  }
}

export function updateComposerState() {
  el.app.classList.toggle("is-streaming", !!state.busy);
  el.sendBtn.title = state.busy ? "Arrêter (Échap)" : "Envoyer";
  el.hint.textContent = state.settings?.sendOnEnter ? "Entrée pour envoyer · Maj+Entrée pour un retour ligne" : "Ctrl+Entrée pour envoyer";
}
