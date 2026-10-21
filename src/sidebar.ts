// Barre latérale : liste des conversations, recherche, projets et mode Chat/Code.
import { api, type Kind, type Project } from "./api";
import { escapeHtml } from "./markdown";
import { workspaceLabel } from "./ssh-ui";
import { findProject, openProjectDialog, projectList } from "./projects-ui";
import { defaultModelFor, el, errMsg, opts, projectWorkspace, state } from "./state";
import { fillModelSelect, icons, toast } from "./ui";
import { renderChrome, setOpt } from "./chrome";
import { renderConversation } from "./thread";
import { stop } from "./run";

// ---------------------------------------------------------------- barre latérale

function dayBucket(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000;
  if (diff <= 0) return "Aujourd'hui";
  if (diff === 1) return "Hier";
  if (diff < 7) return "7 derniers jours";
  if (diff < 30) return "30 derniers jours";
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

export function renderSidebar() {
  document.querySelectorAll<HTMLElement>(".mode-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  el.newChatLabel.textContent = state.mode === "code" ? "Nouvelle session de code" : "Nouvelle conversation";
  renderProjectBar();
  const q = el.search.value.trim().toLowerCase();
  const pf = state.projectFilter;
  const hits = state.search.query === q ? state.search.hits : null;
  const list = state.convs.filter(
    (c) => c.kind === state.mode && (!pf || c.projectId === pf) && (!q || c.title.toLowerCase().includes(q) || !!hits?.has(c.id)),
  );
  let html = "";
  let bucket = "";
  for (const c of list) {
    const b = dayBucket(c.updatedAt);
    if (b !== bucket) {
      html += `<div class="group">${escapeHtml(b)}</div>`;
      bucket = b;
    }
    const active = (c.id === state.current?.id ? " active" : "") + (state.busy && c.id === state.current?.id ? " running" : "");
    const subParts = [
      c.workspace ? workspaceLabel(c.workspace).name : "",
      !pf && c.projectId ? (findProject(c.projectId)?.name ?? "") : "",
    ].filter(Boolean);
    const snippet = q && hits?.get(c.id);
    const sub = snippet
      ? `<span class="conv-sub conv-snippet">${highlight(snippet, q)}</span>`
      : subParts.length ? `<span class="conv-sub">${escapeHtml(subParts.join(" · "))}</span>` : "";
    html += `<div class="conv${active}" data-id="${c.id}">
      <span class="conv-text"><span class="conv-title">${escapeHtml(c.title)}</span>${sub}</span>
      <span class="conv-actions">
        <button class="icon-btn sm" data-act="rename" title="Renommer">${icons.edit}</button>
        <button class="icon-btn sm" data-act="delete" title="Supprimer">${icons.trash}</button>
      </span>
    </div>`;
  }
  const empty = q ? (hits ? "Aucun résultat" : "Recherche…") : pf ? "Aucune conversation dans ce projet" : state.mode === "code" ? "Aucune session de code" : "Aucune conversation";
  el.convList.innerHTML = html || `<p class="empty-list">${empty}</p>`;
}

export const projectOptions = (none: string) =>
  `<option value="">${none}</option>` +
  projectList()
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join("");

function renderProjectBar() {
  if (state.projectFilter && !findProject(state.projectFilter)) state.projectFilter = "";
  el.projectSelect.innerHTML = projectOptions("Toutes les conversations") + '<option value="__new">＋ Nouveau projet…</option>';
  el.projectSelect.value = state.projectFilter;
  el.projectSelect.classList.toggle("on", !!state.projectFilter);
  el.projectEdit.hidden = !state.projectFilter;
}

el.projectSelect.addEventListener("change", () => {
  const v = el.projectSelect.value;
  if (v === "__new") {
    el.projectSelect.value = state.projectFilter;
    return newProject();
  }
  state.projectFilter = v;
  if (state.current && !state.busy && (state.current.projectId ?? "") !== v) return newChat();
  if (!state.current) {
    state.draft.projectId = v || undefined;
    if (state.mode === "code") state.draft.workspace = projectWorkspace(v) ?? state.draft.workspace;
  }
  renderSidebar();
  if (!state.current) renderConversation();
});
el.projectEdit.addEventListener("click", () => openProjectDialog(findProject(state.projectFilter)));
el.convProject.addEventListener("change", () => {
  const id = el.convProject.value || undefined;
  // Nouvelle session de code : on se place dans le dossier du projet choisi.
  if (!state.current && state.mode === "code") state.draft.workspace = projectWorkspace(id) ?? state.draft.workspace;
  setOpt("projectId", id);
  if (!state.current) renderConversation();
});

/** Nouveau projet : en mode Code, le dossier ouvert est proposé par défaut. */
const newProject = () =>
  openProjectDialog(null, state.mode === "code" && opts().workspace ? { workspace: opts().workspace } : {});

/** Après création, modification ou suppression d'un projet. */
export function onProjectChange(saved: Project | null, deletedId?: string) {
  if (saved) {
    state.projectFilter = saved.id;
    if (!state.current) {
      state.draft.projectId = saved.id;
      if (state.mode === "code") state.draft.workspace = projectWorkspace(saved.id) ?? state.draft.workspace;
    }
    toast(`Projet « ${saved.name} » enregistré`);
  }
  if (deletedId) {
    if (state.projectFilter === deletedId) state.projectFilter = "";
    if (state.draft.projectId === deletedId) state.draft.projectId = undefined;
    toast("Projet supprimé");
  }
  renderSidebar();
  if (state.current) renderChrome();
  else renderConversation();
}

export async function refreshConvs() {
  state.convs = await api.listConversations();
  renderSidebar();
}

/** Met en évidence la requête dans un extrait (insensible à la casse et aux accents). */
function highlight(text: string, q: string): string {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const plain = fold(text);
  const i = plain.indexOf(fold(q));
  if (i < 0 || plain.length !== text.length) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) + `<mark>${escapeHtml(text.slice(i, i + q.length))}</mark>` + escapeHtml(text.slice(i + q.length));
}

let searchTimer = 0;
let searchSeq = 0;
el.search.addEventListener("input", () => {
  renderSidebar();
  clearTimeout(searchTimer);
  const q = el.search.value.trim().toLowerCase();
  if (q.length < 2) return;
  // Recherche dans le contenu des conversations (côté Rust, données déchiffrées en mémoire seulement).
  searchTimer = window.setTimeout(async () => {
    const seq = ++searchSeq;
    const hits = await api.searchConversations(q).catch(() => []);
    if (seq !== searchSeq) return;
    state.search = { query: q, hits: new Map(hits.map((h) => [h.id, h.snippet])) };
    renderSidebar();
  }, 250);
});

document.querySelector(".mode-tabs")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]");
  if (b) setMode(b.dataset.mode as Kind);
});

export function setMode(mode: Kind) {
  if (state.mode === mode && !state.current) return;
  state.mode = mode;
  newChat();
}

el.convList.addEventListener("click", async (ev) => {
  const target = ev.target as HTMLElement;
  const row = target.closest<HTMLElement>(".conv");
  if (!row) return;
  const id = row.dataset.id!;
  const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;

  if (act === "delete") {
    const btn = target.closest<HTMLElement>("[data-act]")!;
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.title = "Cliquer à nouveau pour confirmer";
      setTimeout(() => btn.classList.remove("confirm"), 3000);
      return;
    }
    if (state.busy && state.current?.id === id) await stop();
    await api.deleteConversation(id);
    if (state.current?.id === id) newChat();
    await refreshConvs();
    return;
  }

  if (act === "rename") {
    const titleEl = row.querySelector<HTMLElement>(".conv-title")!;
    const input = document.createElement("input");
    input.className = "rename";
    input.value = titleEl.textContent ?? "";
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title) {
        const conv = state.current?.id === id ? state.current : await api.loadConversation(id);
        conv.title = title;
        await api.saveConversation(conv);
        if (state.current?.id === id) el.title.textContent = title;
      }
      await refreshConvs();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    return;
  }

  if (state.current?.id !== id) await openConversation(id);
});

export async function openConversation(id: string) {
  if (state.busy) {
    toast("Arrêtez la génération en cours avant de changer de conversation.", true);
    return;
  }
  try {
    state.current = await api.loadConversation(id);
  } catch (e) {
    toast(errMsg(e), true);
    return;
  }
  state.current.kind ??= "chat";
  state.mode = state.current.kind;
  state.selectedModel = state.current.model || defaultModelFor(state.mode);
  fillModelSelect(el.modelSelect, state.selectedModel);
  if (state.current.workspace) api.touchWorkspace(state.current.workspace).catch(() => {});
  renderSidebar();
  renderConversation();
  el.input.focus();
}


export function newChat() {
  if (state.busy) {
    toast("Arrêtez la génération en cours d'abord.", true);
    return;
  }
  state.current = null;
  state.draft = {
    // Pas de dossier repris en silence : on le choisit explicitement (sauf projet avec dossier).
    workspace: state.mode === "code" ? projectWorkspace(state.projectFilter) : undefined,
    webSearch: state.settings.webSearchDefault,
    mcp: true,
    permissionMode: state.settings.defaultPermission ?? "auto",
    projectId: state.projectFilter || undefined,
  };
  state.selectedModel = defaultModelFor(state.mode);
  fillModelSelect(el.modelSelect, state.selectedModel);
  renderSidebar();
  renderConversation();
  el.input.focus();
}
