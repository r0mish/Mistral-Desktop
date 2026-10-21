import "highlight.js/styles/github-dark.css";
import "./styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { today } from "./usage";
import { initSshUi, loadHosts } from "./ssh-ui";
import { initGitUi, toggleGitPanel } from "./git-ui";
import { initProjectsUi, loadProjects } from "./projects-ui";
import { cancelDictation, initDictation, toggleDictation } from "./dictation";
import { $, el, errMsg, opts, state } from "./state";
import { applyTheme, loadModels, toast } from "./ui";
import { newChat, onProjectChange, refreshConvs, setMode } from "./sidebar";
import { openRemoteWorkspace, toggleWsMenu } from "./chrome";
import { renderUsage, stop } from "./run";
import { openSettings, pollMcp, refreshKeyStatus } from "./settings-ui";
import { initUpdates } from "./updates-ui";
import "./attachments";

$("#open-settings").addEventListener("click", () => openSettings());
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
  const k = e.key.toLowerCase();
  if (mod && k === "n") {
    e.preventDefault();
    newChat();
  } else if (mod && e.key === ",") {
    e.preventDefault();
    openSettings();
  } else if (mod && k === "b") {
    e.preventDefault();
    el.app.classList.toggle("sidebar-hidden");
  } else if (mod && k === "k") {
    e.preventDefault();
    el.search.focus();
  } else if (mod && k === "g" && opts().kind === "code" && opts().workspace) {
    e.preventDefault();
    toggleGitPanel();
  } else if (mod && (e.key === "1" || e.key === "2")) {
    e.preventDefault();
    setMode(e.key === "1" ? "chat" : "code");
  } else if (mod && e.shiftKey && k === "d") {
    e.preventDefault();
    toggleDictation();
  } else if (e.key === "Escape" && !el.wsMenu.hidden) {
    e.preventDefault();
    toggleWsMenu(false);
  } else if (e.key === "Escape" && document.querySelector("dialog[open]")) {
    // WebKitGTK ne ferme pas toujours le <dialog> natif avec Échap.
    e.preventDefault();
    [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].pop()!.close();
  } else if (e.key === "Escape" && cancelDictation()) {
    e.preventDefault();
  } else if (e.key === "Escape" && state.busy) {
    stop();
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
  state.platform = await api.platform().catch(() => state.platform);
  state.workspaces = await api.listWorkspaces().catch(() => []);
  await loadHosts();
  await loadProjects();
  initSshUi({ onOpen: openRemoteWorkspace, toast });
  initProjectsUi({
    onChange: onProjectChange,
    toast,
    onWorkspaceAdded: () => api.listWorkspaces().then((w) => (state.workspaces = w)).catch(() => {}),
  });
  initDictation({ input: el.input, toast });
  initGitUi({
    workspace: () => (opts().kind === "code" ? opts().workspace : undefined),
    model: () => state.selectedModel || state.settings.codeModel,
    toast,
    recordUsage: (model, p, c) => {
      api.recordUsage(today(), model, p, c).catch(() => {});
      if (state.current) {
        state.current.extraUsage ??= {};
        const u = (state.current.extraUsage[model] ??= { promptTokens: 0, completionTokens: 0 });
        u.promptTokens += p;
        u.completionTokens += c;
        renderUsage();
      }
    },
  });
  await refreshKeyStatus();
  newChat();
  await refreshConvs().catch((e) => toast(errMsg(e), true));
  pollMcp();
  el.input.focus();
  await loadModels();
  renderUsage();
  await initUpdates();
}

init();
