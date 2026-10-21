// Utilitaires d'interface : notifications, thème, presse-papiers, icônes et liste des modèles.
import { api, type Settings } from "./api";
import { escapeHtml } from "./markdown";
import { el, errMsg, state } from "./state";

// ---------------------------------------------------------------- utilitaires

let toastTimer = 0;
export function toast(msg: string, isError = false) {
  el.toast.textContent = msg;
  el.toast.className = isError ? "error" : "";
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), isError ? 6000 : 2500);
}



export function applyTheme(theme: Settings["theme"]) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

export async function copy(text: string, btn?: HTMLElement) {
  await navigator.clipboard.writeText(text);
  if (btn) {
    const old = btn.innerHTML;
    btn.textContent = "Copié";
    setTimeout(() => (btn.innerHTML = old), 1200);
  }
}

export const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
};

export function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
}

// ---------------------------------------------------------------- modèles

const FALLBACK_MODELS = [
  "mistral-medium-latest",
  "mistral-large-latest",
  "mistral-small-latest",
  "magistral-medium-latest",
  "devstral-medium-latest",
  "codestral-latest",
];

function modelIds(): string[] {
  const ids = state.models.length ? state.models.map((m) => m.id) : [...FALLBACK_MODELS];
  for (const extra of [state.settings.defaultModel, state.settings.codeModel, state.current?.model, state.selectedModel]) {
    if (extra && !ids.includes(extra)) ids.unshift(extra);
  }
  return ids;
}

export function fillModelSelect(select: HTMLSelectElement, value: string) {
  select.innerHTML = modelIds()
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
    .join("");
  select.value = value;
}

export async function loadModels() {
  if (!state.keyConfigured) return;
  try {
    state.models = await api.listModels();
  } catch (e) {
    toast(`Liste des modèles indisponible : ${errMsg(e)}`, true);
  }
  fillModelSelect(el.modelSelect, state.selectedModel);
}
