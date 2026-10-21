// Fil de la conversation : accueil, rendu des messages, édition et régénération.
import { INIT_AGENTS_PROMPT, toolCardHtml } from "./agent";
import type { Message, Risk } from "./api";
import { escapeHtml, renderMarkdown } from "./markdown";
import { openSshDialog, workspaceLabel } from "./ssh-ui";
import { findProject, openProjectDialog, projectChars } from "./projects-ui";
import { el, FULL_PROJECT_CHARS, opts, state } from "./state";
import { autoGrow, copy, icons } from "./ui";
import { chooseWorkspace, renderChrome, selectWorkspace } from "./chrome";
import { runAgent } from "./run";
import { openSettings } from "./settings-ui";

// ---------------------------------------------------------------- messages

export function renderWelcome() {
  if (!state.keyConfigured) {
    el.messages.innerHTML = `<div class="welcome"><h2>Bienvenue</h2>
      <p>Pour commencer, ajoutez votre clé API Mistral.</p>
      <p class="muted small">Elle reste sur cet appareil, dans le trousseau du système.</p>
      <p><button class="btn-primary" data-open-settings>Configurer la clé API</button></p>
      <p class="muted small"><a href="https://console.mistral.ai/api-keys" data-external>Créer une clé sur console.mistral.ai</a></p>
    </div>`;
    return;
  }
  if (state.mode === "code") {
    const ws = state.draft.workspace;
    const recent = state.workspaces
      .filter((w) => w !== ws)
      .slice(0, 8)
      .map((w) => {
        const l = workspaceLabel(w);
        return `<button class="ws-item" data-ws="${escapeHtml(w)}" title="${escapeHtml(l.detail)}">${l.remote ? icons.server : icons.folder}<span>${escapeHtml(l.name)}</span><small>${escapeHtml(l.detail)}</small></button>`;
      })
      .join("");
    const cur = ws ? workspaceLabel(ws) : null;
    const selected = cur
      ? `<div class="ws-current selected">${cur.remote ? icons.server : icons.folder}<div><small class="ws-tag">Dossier de cette session</small><strong>${escapeHtml(cur.name)}</strong><small>${escapeHtml(cur.detail)}</small></div></div>
         ${instrHint(ws!)}`
      : "";
    el.messages.innerHTML = `<div class="welcome code">
      <h2>Nouvelle session de code</h2>
      <p>${cur ? "L'agent va travailler dans ce dossier. Décrivez la tâche ci-dessous, ou choisissez un autre dossier." : "Où l'agent doit-il travailler ? Choisissez un dossier de cet ordinateur ou d'un serveur distant."}</p>
      ${selected}
      <div class="ws-choices">
        <button class="ws-choice" data-pick-ws>${icons.folder}<strong>Dossier local</strong><small>Un dossier de cet ordinateur</small></button>
        <button class="ws-choice" data-ssh>${icons.server}<strong>Serveur SSH</strong><small>Un dossier sur une machine distante</small></button>
      </div>
      ${projectBanner()}
      ${recent ? `<div class="ws-recent"><div class="group">Dossiers récents</div>${recent}</div>` : ""}
      <p class="muted small center">Chaque modification et commande peut être soumise à votre approbation (menu « Tout demander » en haut).</p>
    </div>`;
    return;
  }
  const hour = new Date().getHours();
  const greet = hour < 6 || hour >= 18 ? "Bonsoir" : "Bonjour";
  const p = findProject(state.draft.projectId);
  el.messages.innerHTML = p
    ? `<div class="welcome"><h2>${escapeHtml(p.name)}</h2><p>Nouvelle conversation dans ce projet.</p>${projectBanner()}</div>`
    : `<div class="welcome"><h2>${greet} 👋</h2><p>Comment puis-je vous aider ?</p></div>`;
}

function instrHint(ws: string): string {
  const files = state.instructions.get(ws);
  if (!files) return "";
  if (files.length) {
    return `<p class="instr-hint">✓ Consignes chargées automatiquement : <strong>${files.map((f) => escapeHtml(f.name)).join(", ")}</strong></p>`;
  }
  return `<p class="instr-hint">Aucun fichier <code>AGENTS.md</code> : l'agent redécouvre le projet à chaque session.
    <button class="btn-ghost sm" data-init-agents>Le faire générer par l'agent</button></p>`;
}

function projectBanner(): string {
  const p = findProject(state.draft.projectId);
  if (!p) return "";
  const n = p.files.length;
  const bits = [
    p.instructions.trim() ? "consignes" : "",
    n ? `${n} fichier${n > 1 ? "s" : ""} de référence` : "",
    p.workspace ? `dossier ${workspaceLabel(p.workspace).name}` : "",
    projectChars(p) > FULL_PROJECT_CHARS
      ? "recherche locale par extraits"
      : `≈ ${Math.round(projectChars(p) / 3.5).toLocaleString("fr-FR")} tokens de contexte`,
  ].filter(Boolean);
  return `<div class="project-banner">${icons.folder}<div><strong>Projet ${escapeHtml(p.name)}</strong><small>${bits.join(" · ")}</small></div>
    <button class="btn-ghost sm" data-edit-project>Modifier</button></div>`;
}

function messageHtml(m: Message, next: Message | undefined): string {
  if (m.role === "user" && m.auto) {
    return `<div class="msg auto" data-id="${m.id}">↻ Relance automatique : l'agent avait annoncé une action sans l'exécuter</div>`;
  }
  if (m.role === "user") {
    const imgs = (m.images ?? []).map((src) => `<img src="${src}" alt="image jointe" />`).join("");
    const files = (m.files ?? []).map((f) => `<span class="chip">${icons.file}${escapeHtml(f.name)}</span>`).join("");
    return `<div class="msg user" data-id="${m.id}">
      ${imgs || files ? `<div class="msg-attachments">${imgs}${files}</div>` : ""}
      <div class="bubble">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div>
      <div class="msg-actions">
        <button class="icon-btn sm" data-act="copy" title="Copier">${icons.copy}</button>
        <button class="icon-btn sm" data-act="edit" title="Modifier et renvoyer">${icons.edit}</button>
      </div>
    </div>`;
  }
  const streaming = state.busy?.msgId === m.id;
  const reasoning = m.reasoning
    ? `<details class="reasoning"${streaming && !m.content ? " open" : ""}><summary>Raisonnement</summary><div class="md">${renderMarkdown(m.reasoning)}</div></details>`
    : "";
  const tools = (m.toolCalls ?? []).map((tc) => toolCardHtml(tc, state.risks.get(tc.name) ?? guessRisk(tc.name))).join("");
  const body = m.content
    ? renderMarkdown(m.content)
    : streaming && !m.reasoning && !tools ? '<span class="typing"><i></i><i></i><i></i></span>' : "";
  const meta = [m.model, m.usage ? `${m.usage.promptTokens} → ${m.usage.completionTokens} tokens` : "", m.cancelled ? "interrompu" : ""]
    .filter(Boolean)
    .join(" · ");
  const error = m.error
    ? `<div class="msg-error">${escapeHtml(m.error)} <button class="btn-ghost sm" data-act="retry">Réessayer</button></div>`
    : "";
  const endOfTurn = !next || next.role === "user";
  // Pendant l'exécution, le dernier message n'a pas encore d'actions (copier, régénérer…).
  const actions = streaming || !endOfTurn || (state.busy && !next)
    ? ""
    : `<div class="msg-actions">
        <button class="icon-btn sm" data-act="copy" title="Copier">${icons.copy}</button>
        ${!next ? `<button class="icon-btn sm" data-act="retry" title="Régénérer">${icons.retry}</button>` : ""}
        <span class="meta">${escapeHtml(meta)}</span>
      </div>`;
  return `<div class="msg assistant${streaming ? " streaming" : ""}" data-id="${m.id}">
    ${reasoning}${body ? `<div class="md">${body}</div>` : ""}${tools ? `<div class="tools">${tools}</div>` : ""}${error}${actions}
  </div>`;
}

/** Risque déduit du nom quand la définition n'est pas (encore) chargée. */
export function guessRisk(name: string): Risk {
  if (name === "write_file" || name === "edit_file") return "write";
  if (name === "run_command") return "exec";
  if (name.startsWith("mcp_")) return "mcp";
  return "read";
}

const nearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;
export const scrollBottom = () => (el.messages.scrollTop = el.messages.scrollHeight);

export function renderConversation() {
  renderChrome();
  const c = state.current;
  if (!c || c.messages.length === 0) return renderWelcome();
  const divider = (i: number) =>
    c.compaction && c.compaction.upto === i
      ? `<details class="compaction"><summary>Contexte compacté ici le ${new Date(c.compaction.at).toLocaleString("fr-FR")} : les messages précédents sont remplacés par ce résumé pour le modèle</summary><div class="md">${renderMarkdown(c.compaction.summary)}</div></details>`
      : "";
  el.messages.innerHTML = `<div class="thread">${c.messages.map((m, i) => divider(i) + messageHtml(m, c.messages[i + 1])).join("")}${divider(c.messages.length)}</div>`;
  scrollBottom();
}

/** Re-rendu d'un seul message, limité à une fois par frame pendant le streaming. */
const dirty = new Set<Message>();
let rafPending = false;
export function rerenderMessage(m: Message, force = false) {
  dirty.add(m);
  const draw = () => {
    rafPending = false;
    const c = state.current;
    if (!c) return dirty.clear();
    const stick = nearBottom();
    for (const msg of dirty) {
      const node = el.messages.querySelector(`.msg[data-id="${msg.id}"]`);
      const idx = c.messages.indexOf(msg);
      if (idx < 0) continue;
      if (!node) {
        // Nouveau message (tour suivant de l'agent) : on l'ajoute au fil.
        const thread = el.messages.querySelector(".thread");
        if (!thread) {
          renderConversation();
          break;
        }
        thread.insertAdjacentHTML("beforeend", messageHtml(msg, c.messages[idx + 1]));
        // Le message précédent perd ses actions de fin de tour.
        const prev = c.messages[idx - 1];
        const prevNode = prev && el.messages.querySelector(`.msg[data-id="${prev.id}"]`);
        if (prevNode) prevNode.outerHTML = messageHtml(prev, msg);
        continue;
      }
      const openDetails = [...node.querySelectorAll("details")].map((d) => d.open);
      node.outerHTML = messageHtml(msg, c.messages[idx + 1]);
      const fresh = el.messages.querySelector(`.msg[data-id="${msg.id}"]`);
      fresh?.querySelectorAll("details").forEach((d, i) => {
        if (openDetails[i] !== undefined) d.open = openDetails[i];
      });
    }
    dirty.clear();
    if (stick) scrollBottom();
  };
  if (force) return draw();
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(draw);
  }
}

el.messages.addEventListener("click", async (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-open-settings]")) return openSettings();
  if (t.closest("[data-pick-ws]")) return chooseWorkspace();
  if (t.closest("[data-ssh]")) return openSshDialog();
  if (t.closest("[data-edit-project]")) return openProjectDialog(findProject(opts().projectId));
  if (t.closest("[data-init-agents]")) {
    el.input.value = INIT_AGENTS_PROMPT;
    autoGrow(el.input);
    return el.input.focus();
  }
  const wsItem = t.closest<HTMLElement>("[data-ws]");
  if (wsItem) return selectWorkspace(wsItem.dataset.ws!);

  const approve = t.closest<HTMLElement>("[data-approve]");
  if (approve) {
    const id = approve.closest<HTMLElement>("[data-tc]")?.dataset.tc;
    const resolve = id && state.approvals.get(id);
    if (resolve) resolve(approve.dataset.approve as "allow" | "always" | "deny");
    return;
  }

  const codeBtn = t.closest<HTMLElement>(".copy-code");
  if (codeBtn) {
    const code = codeBtn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    return copy(code, codeBtn);
  }

  const actBtn = t.closest<HTMLElement>("[data-act]");
  const msgEl = t.closest<HTMLElement>(".msg");
  if (!actBtn || !msgEl || !state.current) return;
  const msg = state.current.messages.find((m) => m.id === msgEl.dataset.id);
  if (!msg) return;

  switch (actBtn.dataset.act) {
    case "copy":
      return copy(turnText(msg), actBtn);
    case "retry":
      return regenerate(msg);
    case "edit":
      return editMessage(msg, msgEl);
  }
});

/** Texte d'un tour complet de l'agent (plusieurs messages assistant consécutifs). */
function turnText(msg: Message): string {
  if (msg.role === "user" || !state.current) return msg.content;
  const msgs = state.current.messages;
  let i = msgs.indexOf(msg);
  const parts: string[] = [];
  while (i >= 0 && msgs[i].role === "assistant") parts.unshift(msgs[i--].content);
  return parts.filter((p) => p.trim()).join("\n\n");
}

function editMessage(msg: Message, node: HTMLElement) {
  if (state.busy) return;
  const bubble = node.querySelector<HTMLElement>(".bubble")!;
  const box = document.createElement("div");
  box.className = "edit-box";
  box.innerHTML = `<textarea rows="3"></textarea>
    <div class="row end"><button class="btn-ghost" data-edit="cancel">Annuler</button>
    <button class="btn-primary" data-edit="send">Envoyer</button></div>`;
  const ta = box.querySelector("textarea")!;
  ta.value = msg.content;
  bubble.replaceWith(box);
  node.querySelector(".msg-actions")?.remove();
  ta.focus();
  autoGrow(ta);
  ta.addEventListener("input", () => autoGrow(ta));
  box.addEventListener("click", async (e) => {
    const action = (e.target as HTMLElement).dataset.edit;
    if (action === "cancel") renderConversation();
    if (action === "send") {
      const text = ta.value.trim();
      if (!text || !state.current) return;
      const idx = state.current.messages.findIndex((m) => m.id === msg.id);
      msg.content = text;
      state.current.messages = state.current.messages.slice(0, idx + 1);
      await runAgent();
    }
  });
}

async function regenerate(msg: Message) {
  if (state.busy || !state.current) return;
  const msgs = state.current.messages;
  let idx = msgs.indexOf(msg);
  // On repart du dernier message utilisateur précédant ce tour.
  while (idx >= 0 && msgs[idx].role !== "user") idx--;
  if (idx < 0) return;
  state.current.messages = msgs.slice(0, idx + 1);
  renderConversation();
  await runAgent();
}
