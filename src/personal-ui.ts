// Personnalisation : mémoire persistante et assistants réutilisables (Réglages → Personnalisation),
// choix de l'assistant d'une nouvelle conversation (barre du haut).
import { api, type Assistant } from "./api";
import { escapeHtml } from "./markdown";
import { $, el, errMsg, opts, state, uid } from "./state";
import { fillModelSelect, toast } from "./ui";
import { renderChrome } from "./chrome";

const p = {
  memList: $("#mem-list"),
  memInput: $<HTMLInputElement>("#mem-input"),
  memAdd: $<HTMLButtonElement>("#mem-add"),
  memClear: $<HTMLButtonElement>("#mem-clear"),
  asList: $("#as-list"),
  asForm: $("#as-form"),
  asName: $<HTMLInputElement>("#as-name"),
  asModel: $<HTMLSelectElement>("#as-model"),
  asTemp: $<HTMLInputElement>("#as-temp"),
  asInstructions: $<HTMLTextAreaElement>("#as-instructions"),
  asNew: $<HTMLButtonElement>("#as-new"),
  asSave: $<HTMLButtonElement>("#as-save"),
  asCancel: $<HTMLButtonElement>("#as-cancel"),
};

let editingId: string | null = null;

export async function loadPersonal() {
  state.memories = await api.listMemories().catch(() => []);
  state.assistants = await api.listAssistants().catch(() => []);
}

export const findAssistant = (id?: string) => (id ? state.assistants.find((a) => a.id === id) : undefined);

// ---------------------------------------------------------------- mémoire

export function renderMemory() {
  const items = state.memories;
  p.memList.innerHTML = items.length
    ? items
        .map(
          (m) => `<div class="mem-item" data-id="${escapeHtml(m.id)}"><span>${escapeHtml(m.text)}</span>
            <small>${new Date(m.createdAt).toLocaleDateString("fr-FR")}</small>
            <button type="button" class="icon-btn sm" data-mem-rm title="Oublier">×</button></div>`,
        )
        .join("")
    : '<p class="muted small">Rien en mémoire pour l\'instant. Ajoutez un fait ci-dessous, ou dites au modèle « retiens que… ».</p>';
  p.memClear.hidden = !items.length;
}

async function saveMemories(items = state.memories) {
  try {
    await api.saveMemories(items);
    state.memories = items;
  } catch (e) {
    toast(errMsg(e), true);
  }
  renderMemory();
}

p.memAdd.addEventListener("click", async () => {
  const text = p.memInput.value.trim();
  if (!text) return;
  await saveMemories([...state.memories, { id: uid(), text, createdAt: Date.now() }]);
  p.memInput.value = "";
});
p.memInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    p.memAdd.click();
  }
});
p.memList.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-mem-rm]")?.closest<HTMLElement>(".mem-item");
  if (row) saveMemories(state.memories.filter((m) => m.id !== row.dataset.id));
});
p.memClear.addEventListener("click", () => {
  if (!p.memClear.classList.contains("confirm")) {
    p.memClear.classList.add("confirm");
    p.memClear.textContent = "Confirmer : tout oublier";
    setTimeout(() => {
      p.memClear.classList.remove("confirm");
      p.memClear.textContent = "Tout oublier";
    }, 3000);
    return;
  }
  p.memClear.classList.remove("confirm");
  p.memClear.textContent = "Tout oublier";
  saveMemories([]);
});

// ---------------------------------------------------------------- assistants

export function renderAssistants() {
  const items = state.assistants;
  p.asList.innerHTML = items.length
    ? items
        .map(
          (a) => `<div class="as-item" data-id="${escapeHtml(a.id)}"><div><strong>${escapeHtml(a.name)}</strong>
            <small>${escapeHtml(a.model || "modèle par défaut")}${a.temperature !== null ? ` · température ${a.temperature}` : ""}</small></div>
            <button type="button" class="btn-ghost sm" data-as-edit>Modifier</button>
            <button type="button" class="icon-btn sm" data-as-rm title="Supprimer">×</button></div>`,
        )
        .join("")
    : '<p class="muted small">Aucun assistant. Un assistant regroupe des consignes, un modèle et une température : « Traducteur technique », « Relecteur », « Admin Linux »…</p>';
  p.asForm.hidden = editingId === null;
  p.asNew.hidden = editingId !== null;
}

function editAssistant(a: Assistant | null) {
  editingId = a?.id ?? "";
  p.asName.value = a?.name ?? "";
  fillModelSelect(p.asModel, a?.model ?? "");
  p.asModel.insertAdjacentHTML("afterbegin", '<option value="">Modèle par défaut</option>');
  p.asModel.value = a?.model ?? "";
  p.asTemp.value = a?.temperature?.toString() ?? "";
  p.asInstructions.value = a?.instructions ?? "";
  renderAssistants();
  p.asName.focus();
}

async function saveAssistants(items: Assistant[]) {
  await api.saveAssistants(items);
  state.assistants = items;
  if (state.draft.assistantId && !findAssistant(state.draft.assistantId)) state.draft.assistantId = undefined;
  renderAssistants();
  renderChrome();
}

p.asNew.addEventListener("click", () => editAssistant(null));
p.asCancel.addEventListener("click", () => {
  editingId = null;
  renderAssistants();
});
p.asSave.addEventListener("click", async () => {
  const name = p.asName.value.trim();
  if (!name) return toast("Donnez un nom à l'assistant.", true);
  const t = p.asTemp.value.trim();
  const a: Assistant = {
    id: editingId || uid(),
    name,
    instructions: p.asInstructions.value.trim(),
    model: p.asModel.value,
    temperature: t === "" ? null : Math.min(1.5, Math.max(0, Number(t))),
  };
  try {
    const exists = state.assistants.some((x) => x.id === a.id);
    await saveAssistants(exists ? state.assistants.map((x) => (x.id === a.id ? a : x)) : [...state.assistants, a]);
    editingId = null;
    renderAssistants();
    toast(`Assistant « ${a.name} » enregistré`);
  } catch (e) {
    toast(errMsg(e), true);
  }
});
p.asList.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const id = t.closest<HTMLElement>(".as-item")?.dataset.id;
  const a = findAssistant(id);
  if (!a) return;
  if (t.closest("[data-as-edit]")) return editAssistant(a);
  const rm = t.closest<HTMLElement>("[data-as-rm]");
  if (rm) {
    if (!rm.classList.contains("confirm")) {
      rm.classList.add("confirm");
      rm.title = "Cliquer à nouveau pour confirmer";
      setTimeout(() => rm.classList.remove("confirm"), 3000);
      return;
    }
    await saveAssistants(state.assistants.filter((x) => x.id !== a.id)).catch((err) => toast(errMsg(err), true));
  }
});

/** Onglet Personnalisation à l'ouverture des réglages. */
export function renderPersonalTab() {
  editingId = null;
  renderMemory();
  renderAssistants();
}

// ---------------------------------------------------------------- barre du haut

/** Sélecteur d'assistant (nouvelle conversation) ou nom de l'assistant de la conversation ouverte. */
export function renderAssistantPicker() {
  const c = state.current;
  const o = opts();
  const current = c ? findAssistant(c.assistantId) : undefined;
  el.assistantChip.hidden = !current;
  if (current) {
    el.assistantChip.textContent = current.name;
    el.assistantChip.title = `Assistant « ${current.name} »${current.instructions ? `\n\n${current.instructions.slice(0, 400)}` : ""}`;
  }
  const show = !c && o.kind === "chat";
  el.assistantSelect.hidden = !show;
  if (!show) return;
  el.assistantSelect.innerHTML =
    '<option value="">Assistant standard</option>' +
    state.assistants.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("") +
    '<option value="__new">＋ Nouvel assistant…</option>';
  el.assistantSelect.value = findAssistant(state.draft.assistantId) ? state.draft.assistantId! : "";
  el.assistantSelect.classList.toggle("on", !!el.assistantSelect.value);
}

let openSettingsTab: (tab: string) => Promise<void> = async () => {};
export function initPersonalUi(opts: { openSettings: (tab: string) => Promise<void> }) {
  openSettingsTab = opts.openSettings;
}

el.assistantSelect.addEventListener("change", async () => {
  const v = el.assistantSelect.value;
  if (v === "__new") {
    renderAssistantPicker();
    await openSettingsTab("personal");
    editAssistant(null);
    return;
  }
  state.draft.assistantId = v || undefined;
  const a = findAssistant(v);
  state.selectedModel = a?.model || state.settings.defaultModel;
  fillModelSelect(el.modelSelect, state.selectedModel);
  renderChrome();
  el.input.focus();
});
