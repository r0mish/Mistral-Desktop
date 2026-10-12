import "highlight.js/styles/github-dark.css";
import "./styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  type ApiMessage,
  type Conversation,
  type ConversationSummary,
  type Message,
  type ModelInfo,
  type Settings,
  type TextFile,
} from "./api";
import { escapeHtml, renderMarkdown } from "./markdown";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const el = {
  app: $("#app"),
  convList: $("#conv-list"),
  search: $<HTMLInputElement>("#search"),
  title: $("#conv-title"),
  modelSelect: $<HTMLSelectElement>("#model-select"),
  exportBtn: $<HTMLButtonElement>("#export-btn"),
  messages: $("#messages"),
  composer: $<HTMLFormElement>("#composer"),
  input: $<HTMLTextAreaElement>("#input"),
  attachments: $("#attachments"),
  fileInput: $<HTMLInputElement>("#file-input"),
  sendBtn: $<HTMLButtonElement>("#send-btn"),
  hint: $("#hint"),
  drop: $("#drop-overlay"),
  toast: $("#toast"),
  settings: $<HTMLDialogElement>("#settings"),
};

const FALLBACK_MODELS = [
  "mistral-medium-latest",
  "mistral-large-latest",
  "mistral-small-latest",
  "magistral-medium-latest",
  "codestral-latest",
];
const MAX_TEXT_FILE = 512 * 1024;
const MAX_IMAGE_SIDE = 2048;

const state = {
  settings: null as unknown as Settings,
  keyConfigured: false,
  models: [] as ModelInfo[],
  convs: [] as ConversationSummary[],
  current: null as Conversation | null,
  streaming: null as { requestId: string; msgId: string } | null,
  pending: { images: [] as string[], files: [] as TextFile[] },
  selectedModel: "",
};

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------- utilitaires

let toastTimer = 0;
function toast(msg: string, isError = false) {
  el.toast.textContent = msg;
  el.toast.className = isError ? "error" : "";
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), isError ? 6000 : 2500);
}

const errMsg = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

function applyTheme(theme: Settings["theme"]) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

async function copy(text: string, btn?: HTMLElement) {
  await navigator.clipboard.writeText(text);
  if (btn) {
    const old = btn.innerHTML;
    btn.textContent = "Copié";
    setTimeout(() => (btn.innerHTML = old), 1200);
  }
}

const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
};

// ---------------------------------------------------------------- modèles

function modelIds(): string[] {
  const ids = state.models.length ? state.models.map((m) => m.id) : [...FALLBACK_MODELS];
  for (const extra of [state.settings.defaultModel, state.current?.model, state.selectedModel]) {
    if (extra && !ids.includes(extra)) ids.unshift(extra);
  }
  return ids;
}

function fillModelSelect(select: HTMLSelectElement, value: string) {
  select.innerHTML = modelIds()
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
    .join("");
  select.value = value;
}

async function loadModels() {
  if (!state.keyConfigured) return;
  try {
    state.models = await api.listModels();
  } catch (e) {
    toast(`Liste des modèles indisponible : ${errMsg(e)}`, true);
  }
  fillModelSelect(el.modelSelect, state.selectedModel);
}

const modelInfo = (id: string) => state.models.find((m) => m.id === id);

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

function renderSidebar() {
  const q = el.search.value.trim().toLowerCase();
  const list = state.convs.filter((c) => !q || c.title.toLowerCase().includes(q));
  let html = "";
  let bucket = "";
  for (const c of list) {
    const b = dayBucket(c.updatedAt);
    if (b !== bucket) {
      html += `<div class="group">${escapeHtml(b)}</div>`;
      bucket = b;
    }
    const active = c.id === state.current?.id ? " active" : "";
    html += `<div class="conv${active}" data-id="${c.id}">
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <span class="conv-actions">
        <button class="icon-btn sm" data-act="rename" title="Renommer">${icons.edit}</button>
        <button class="icon-btn sm" data-act="delete" title="Supprimer">${icons.trash}</button>
      </span>
    </div>`;
  }
  el.convList.innerHTML = html || `<p class="empty-list">${q ? "Aucun résultat" : "Aucune conversation"}</p>`;
}

async function refreshConvs() {
  state.convs = await api.listConversations();
  renderSidebar();
}

el.search.addEventListener("input", renderSidebar);

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
    if (state.streaming && state.current?.id === id) await stopStreaming();
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

async function openConversation(id: string) {
  try {
    state.current = await api.loadConversation(id);
  } catch (e) {
    toast(errMsg(e), true);
    return;
  }
  state.selectedModel = state.current.model || state.settings.defaultModel;
  fillModelSelect(el.modelSelect, state.selectedModel);
  renderSidebar();
  renderConversation();
  el.input.focus();
}

function newChat() {
  state.current = null;
  state.selectedModel = state.settings.defaultModel;
  fillModelSelect(el.modelSelect, state.selectedModel);
  renderSidebar();
  renderConversation();
  el.input.focus();
}

// ---------------------------------------------------------------- messages

function renderWelcome() {
  const hour = new Date().getHours();
  const greet = hour < 6 || hour >= 18 ? "Bonsoir" : "Bonjour";
  el.messages.innerHTML = state.keyConfigured
    ? `<div class="welcome"><h2>${greet} 👋</h2><p>Comment puis-je vous aider ?</p></div>`
    : `<div class="welcome"><h2>Bienvenue</h2>
        <p>Pour commencer, ajoutez votre clé API Mistral.</p>
        <p class="muted small">Elle reste sur cet appareil, dans le trousseau du système.</p>
        <p><button class="btn-primary" data-open-settings>Configurer la clé API</button></p>
        <p class="muted small"><a href="https://console.mistral.ai/api-keys" data-external>Créer une clé sur console.mistral.ai</a></p>
      </div>`;
}

function messageHtml(m: Message, isLast: boolean): string {
  if (m.role === "user") {
    const imgs = (m.images ?? []).map((src) => `<img src="${src}" alt="image jointe" />`).join("");
    const files = (m.files ?? [])
      .map((f) => `<span class="chip">${icons.file}${escapeHtml(f.name)}</span>`)
      .join("");
    return `<div class="msg user" data-id="${m.id}">
      ${imgs || files ? `<div class="msg-attachments">${imgs}${files}</div>` : ""}
      <div class="bubble">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div>
      <div class="msg-actions">
        <button class="icon-btn sm" data-act="copy" title="Copier">${icons.copy}</button>
        <button class="icon-btn sm" data-act="edit" title="Modifier et renvoyer">${icons.edit}</button>
      </div>
    </div>`;
  }
  const streaming = state.streaming?.msgId === m.id;
  const reasoning = m.reasoning
    ? `<details class="reasoning"${streaming && !m.content ? " open" : ""}><summary>Raisonnement</summary><div class="md">${renderMarkdown(m.reasoning)}</div></details>`
    : "";
  const body = m.content
    ? renderMarkdown(m.content)
    : streaming && !m.reasoning ? '<span class="typing"><i></i><i></i><i></i></span>' : "";
  const meta = [m.model, m.usage ? `${m.usage.promptTokens} → ${m.usage.completionTokens} tokens` : "", m.cancelled ? "interrompu" : ""]
    .filter(Boolean)
    .join(" · ");
  const error = m.error
    ? `<div class="msg-error">${escapeHtml(m.error)} <button class="btn-ghost sm" data-act="retry">Réessayer</button></div>`
    : "";
  const actions = streaming
    ? ""
    : `<div class="msg-actions">
        <button class="icon-btn sm" data-act="copy" title="Copier">${icons.copy}</button>
        ${isLast ? `<button class="icon-btn sm" data-act="retry" title="Régénérer">${icons.retry}</button>` : ""}
        <span class="meta">${escapeHtml(meta)}</span>
      </div>`;
  return `<div class="msg assistant${streaming ? " streaming" : ""}" data-id="${m.id}">
    ${reasoning}<div class="md">${body}</div>${error}${actions}
  </div>`;
}

const nearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
const scrollBottom = () => (el.messages.scrollTop = el.messages.scrollHeight);

function renderConversation() {
  const c = state.current;
  el.title.textContent = c?.title ?? "Nouvelle conversation";
  el.exportBtn.hidden = !c;
  updateComposerState();
  if (!c || c.messages.length === 0) return renderWelcome();
  el.messages.innerHTML = `<div class="thread">${c.messages
    .map((m, i) => messageHtml(m, i === c.messages.length - 1))
    .join("")}</div>`;
  scrollBottom();
}

/** Re-rendu d'un seul message (pendant le streaming), limité à une fois par frame. */
let rafPending = false;
function rerenderMessage(m: Message, force = false) {
  const draw = () => {
    rafPending = false;
    const node = el.messages.querySelector(`.msg[data-id="${m.id}"]`);
    if (!node || !state.current) return;
    const stick = nearBottom();
    const msgs = state.current.messages;
    const isLast = msgs[msgs.length - 1]?.id === m.id;
    const open = node.querySelector("details")?.open;
    node.outerHTML = messageHtml(m, isLast);
    const fresh = el.messages.querySelector(`.msg[data-id="${m.id}"] details`) as HTMLDetailsElement | null;
    if (fresh && open !== undefined) fresh.open = open;
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
      return copy(msg.content, actBtn);
    case "retry":
      return regenerate(msg);
    case "edit":
      return editMessage(msg, msgEl);
  }
});

function editMessage(msg: Message, node: HTMLElement) {
  if (state.streaming) return;
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
      await runAssistant();
    }
  });
}

async function regenerate(msg: Message) {
  if (state.streaming || !state.current) return;
  const idx = state.current.messages.findIndex((m) => m.id === msg.id);
  state.current.messages = state.current.messages.slice(0, msg.role === "assistant" ? idx : idx + 1);
  await runAssistant();
}

// ---------------------------------------------------------------- envoi / streaming

function toApiMessages(conv: Conversation): ApiMessage[] {
  const out: ApiMessage[] = [];
  const system = conv.systemPrompt ?? state.settings.systemPrompt;
  if (system?.trim()) out.push({ role: "system", content: system.trim(), images: [] });
  for (const m of conv.messages) {
    if (m.role === "assistant" && (m.error || !m.content)) continue;
    let content = m.content;
    for (const f of m.files ?? []) {
      content += `\n\n<fichier nom="${f.name}">\n${f.text}\n</fichier>`;
    }
    out.push({ role: m.role, content, images: m.images ?? [] });
  }
  return out;
}

async function saveCurrent() {
  if (!state.current) return;
  state.current.updatedAt = Date.now();
  try {
    await api.saveConversation(state.current);
    await refreshConvs();
  } catch (e) {
    toast(`Sauvegarde impossible : ${errMsg(e)}`, true);
  }
}

async function send() {
  if (state.streaming) return stopStreaming();
  const text = el.input.value.trim();
  const { images, files } = state.pending;
  if (!text && !images.length && !files.length) return;
  if (!state.keyConfigured) return openSettings();

  const model = state.selectedModel;
  if (images.length && modelInfo(model)?.vision === false) {
    toast(`Le modèle ${model} ne gère pas les images. Choisissez par ex. mistral-medium-latest.`, true);
    return;
  }

  if (!state.current) {
    const now = Date.now();
    const title = (text || files[0]?.name || "Image").replace(/\s+/g, " ").slice(0, 60);
    state.current = {
      id: uid(),
      title,
      model,
      createdAt: now,
      updatedAt: now,
      systemPrompt: state.settings.systemPrompt || null,
      messages: [],
    };
  }
  state.current.messages.push({
    id: uid(),
    role: "user",
    content: text,
    createdAt: Date.now(),
    ...(images.length ? { images: [...images] } : {}),
    ...(files.length ? { files: [...files] } : {}),
  });
  el.input.value = "";
  autoGrow(el.input);
  state.pending = { images: [], files: [] };
  renderAttachments();
  await runAssistant();
}

async function runAssistant() {
  const conv = state.current;
  if (!conv) return;
  conv.model = state.selectedModel;
  const msg: Message = { id: uid(), role: "assistant", content: "", model: conv.model, createdAt: Date.now() };
  const apiMessages = toApiMessages(conv);
  conv.messages.push(msg);
  const requestId = uid();
  state.streaming = { requestId, msgId: msg.id };
  renderConversation();
  await saveCurrent();

  try {
    await api.chat(
      requestId,
      {
        model: conv.model,
        messages: apiMessages,
        temperature: state.settings.temperature,
        maxTokens: state.settings.maxTokens,
      },
      (ev) => {
        switch (ev.type) {
          case "delta":
            msg.content += ev.text;
            break;
          case "reasoning":
            msg.reasoning = (msg.reasoning ?? "") + ev.text;
            break;
          case "usage":
            msg.usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
            break;
          case "done":
            if (ev.cancelled) msg.cancelled = true;
            if (ev.finishReason === "length") msg.error = "Réponse tronquée (limite de tokens atteinte).";
            break;
        }
        rerenderMessage(msg);
      },
    );
  } catch (e) {
    msg.error = errMsg(e);
  } finally {
    state.streaming = null;
    rerenderMessage(msg, true);
    updateComposerState();
    await saveCurrent();
  }
}

async function stopStreaming() {
  if (state.streaming) await api.cancel(state.streaming.requestId);
}

function updateComposerState() {
  el.app.classList.toggle("is-streaming", !!state.streaming);
  el.sendBtn.title = state.streaming ? "Arrêter (Échap)" : "Envoyer";
  el.hint.textContent = state.settings?.sendOnEnter ? "Entrée pour envoyer · Maj+Entrée pour un retour ligne" : "Ctrl+Entrée pour envoyer";
}

function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
}

el.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
el.input.addEventListener("input", () => autoGrow(el.input));
el.input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if ((state.settings.sendOnEnter && !e.shiftKey) || mod) {
    e.preventDefault();
    send();
  }
});
el.modelSelect.addEventListener("change", () => {
  state.selectedModel = el.modelSelect.value;
});
el.exportBtn.addEventListener("click", async () => {
  if (!state.current) return;
  try {
    if (await api.exportConversation(state.current.id)) toast("Conversation exportée");
  } catch (e) {
    toast(errMsg(e), true);
  }
});

// ---------------------------------------------------------------- pièces jointes

function renderAttachments() {
  const { images, files } = state.pending;
  el.attachments.innerHTML =
    images.map((src, i) => `<span class="att img"><img src="${src}" alt="" /><button type="button" data-rm="img:${i}" title="Retirer">×</button></span>`).join("") +
    files.map((f, i) => `<span class="att chip">${icons.file}${escapeHtml(f.name)}<button type="button" data-rm="file:${i}" title="Retirer">×</button></span>`).join("");
}

el.attachments.addEventListener("click", (e) => {
  const rm = (e.target as HTMLElement).dataset.rm;
  if (!rm) return;
  const [kind, i] = rm.split(":");
  if (kind === "img") state.pending.images.splice(+i, 1);
  else state.pending.files.splice(+i, 1);
  renderAttachments();
});

const readAsDataUrl = (f: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

/** Redimensionne localement les grandes images pour limiter le volume envoyé. */
async function imageToDataUrl(file: File): Promise<string> {
  const url = await readAsDataUrl(file);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = url;
  });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && file.size < 4 * 1024 * 1024) return url;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function addFiles(list: Iterable<File>) {
  for (const file of list) {
    try {
      if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
        state.pending.images.push(await imageToDataUrl(file));
        continue;
      }
      if (file.size > MAX_TEXT_FILE) {
        toast(`${file.name} : trop volumineux (max ${MAX_TEXT_FILE / 1024} Ko)`, true);
        continue;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.subarray(0, 8000).includes(0)) {
        toast(`${file.name} : format non pris en charge (images et fichiers texte uniquement)`, true);
        continue;
      }
      state.pending.files.push({ name: file.name, text: new TextDecoder().decode(buf) });
    } catch (e) {
      toast(`${file.name} : ${errMsg(e)}`, true);
    }
  }
  renderAttachments();
  el.input.focus();
}

$("#attach-btn").addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", async () => {
  await addFiles(el.fileInput.files ?? []);
  el.fileInput.value = "";
});
el.input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

let dragDepth = 0;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  el.drop.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.drop.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- réglages

const s = {
  apiKey: $<HTMLInputElement>("#api-key"),
  keyStatus: $("#key-status"),
  model: $<HTMLSelectElement>("#s-model"),
  system: $<HTMLTextAreaElement>("#s-system"),
  temp: $<HTMLInputElement>("#s-temp"),
  max: $<HTMLInputElement>("#s-max"),
  theme: $<HTMLSelectElement>("#s-theme"),
  enter: $<HTMLInputElement>("#s-enter"),
  base: $<HTMLInputElement>("#s-base"),
  error: $("#settings-error"),
};

async function refreshKeyStatus() {
  const st = await api.keyStatus();
  state.keyConfigured = st.configured;
  s.keyStatus.textContent = !st.configured
    ? "Aucune clé configurée."
    : st.source === "keyring"
      ? "✓ Clé enregistrée dans le trousseau du système."
      : "✓ Clé lue depuis la variable d'environnement MISTRAL_API_KEY.";
}

async function openSettings() {
  const st = state.settings;
  await refreshKeyStatus();
  s.apiKey.value = "";
  fillModelSelect(s.model, st.defaultModel);
  s.system.value = st.systemPrompt;
  s.temp.value = st.temperature?.toString() ?? "";
  s.max.value = st.maxTokens?.toString() ?? "";
  s.theme.value = st.theme;
  s.enter.checked = st.sendOnEnter;
  s.base.value = st.baseUrl;
  s.error.hidden = true;
  $("#data-dir").textContent = await api.dataDir().catch(() => "?");
  el.settings.showModal();
}

$("#save-key").addEventListener("click", async () => {
  try {
    await api.setKey(s.apiKey.value);
    s.apiKey.value = "";
    await refreshKeyStatus();
    await loadModels();
    fillModelSelect(s.model, s.model.value || state.settings.defaultModel);
    if (!state.current) renderWelcome();
    toast("Clé API enregistrée");
  } catch (e) {
    s.error.textContent = errMsg(e);
    s.error.hidden = false;
  }
});

$("#delete-key").addEventListener("click", async () => {
  await api.deleteKey().catch((e) => toast(errMsg(e), true));
  await refreshKeyStatus();
  if (!state.current) renderWelcome();
});

$("#settings-cancel").addEventListener("click", () => el.settings.close());
s.theme.addEventListener("change", () => applyTheme(s.theme.value as Settings["theme"]));
el.settings.addEventListener("close", () => applyTheme(state.settings.theme));

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const next: Settings = {
    baseUrl: s.base.value.trim() || "https://api.mistral.ai",
    defaultModel: s.model.value,
    systemPrompt: s.system.value,
    temperature: num(s.temp.value),
    maxTokens: num(s.max.value),
    theme: s.theme.value as Settings["theme"],
    sendOnEnter: s.enter.checked,
  };
  try {
    const baseChanged = next.baseUrl !== state.settings.baseUrl;
    await api.saveSettings(next);
    state.settings = next;
    applyTheme(next.theme);
    if (!state.current) state.selectedModel = next.defaultModel;
    updateComposerState();
    el.settings.close();
    if (baseChanged) await loadModels();
    else fillModelSelect(el.modelSelect, state.selectedModel);
  } catch (err) {
    s.error.textContent = errMsg(err);
    s.error.hidden = false;
  }
});

$("#open-settings").addEventListener("click", openSettings);
$("#new-chat").addEventListener("click", newChat);
$("#toggle-sidebar").addEventListener("click", () => el.app.classList.toggle("sidebar-hidden"));

// Liens : toujours dans le navigateur du système, jamais dans la WebView.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^(https?:|mailto:)/i.test(href)) openUrl(href).catch((err) => toast(errMsg(err), true));
});

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newChat();
  } else if (mod && e.key === ",") {
    e.preventDefault();
    openSettings();
  } else if (mod && e.key.toLowerCase() === "b") {
    e.preventDefault();
    el.app.classList.toggle("sidebar-hidden");
  } else if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    el.search.focus();
  } else if (e.key === "Escape" && state.streaming && !el.settings.open) {
    stopStreaming();
  }
});

// ---------------------------------------------------------------- démarrage

async function init() {
  try {
    state.settings = await api.getSettings();
  } catch (e) {
    toast(errMsg(e), true);
    return;
  }
  applyTheme(state.settings.theme);
  state.selectedModel = state.settings.defaultModel;
  await refreshKeyStatus();
  fillModelSelect(el.modelSelect, state.selectedModel);
  renderConversation();
  await refreshConvs().catch((e) => toast(errMsg(e), true));
  el.input.focus();
  await loadModels();
}

init();
