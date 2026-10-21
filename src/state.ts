// État partagé de l'interface : éléments du DOM, conversation ouverte, brouillon et options effectives.
import type { ConversationSummary, Conversation, InstructionFile, Kind, McpServerStatus, ModelInfo, PermissionMode, ProjectContext, Risk, Settings, TextFile, ToolContext, UpdateInfo } from "./api";
import { systemPrompt, type Platform } from "./agent";
import { parseRemote } from "./ssh-ui";
import { findProject, projectChars } from "./projects-ui";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export const el = {
  app: $("#app"),
  convList: $("#conv-list"),
  search: $<HTMLInputElement>("#search"),
  newChatLabel: $("#new-chat-label"),
  title: $("#conv-title"),
  wsChip: $<HTMLButtonElement>("#ws-chip"),
  permSelect: $<HTMLSelectElement>("#perm-select"),
  modelSelect: $<HTMLSelectElement>("#model-select"),
  exportBtn: $<HTMLButtonElement>("#export-btn"),
  messages: $("#messages"),
  composer: $<HTMLFormElement>("#composer"),
  input: $<HTMLTextAreaElement>("#input"),
  attachments: $("#attachments"),
  fileInput: $<HTMLInputElement>("#file-input"),
  webToggle: $<HTMLButtonElement>("#web-toggle"),
  mcpToggle: $<HTMLButtonElement>("#mcp-toggle"),
  sysToggle: $<HTMLButtonElement>("#sys-toggle"),
  sendBtn: $<HTMLButtonElement>("#send-btn"),
  hint: $("#hint"),
  drop: $("#drop-overlay"),
  toast: $("#toast"),
  settings: $<HTMLDialogElement>("#settings"),
  activity: $("#activity"),
  ctxMeter: $<HTMLButtonElement>("#ctx-meter"),
  usageInfo: $("#usage-info"),
  updateBanner: $("#update-banner"),
  gitBtn: $<HTMLButtonElement>("#git-btn"),
  wsPicker: $<HTMLButtonElement>("#ws-picker"),
  wsMenu: $("#ws-menu"),
  instrChip: $<HTMLButtonElement>("#instr-chip"),
  projectSelect: $<HTMLSelectElement>("#project-select"),
  projectEdit: $<HTMLButtonElement>("#project-edit"),
  convProject: $<HTMLSelectElement>("#conv-project"),
};

/** Ce que fait l'agent en ce moment (barre d'activité). */
export interface Activity {
  phase: string;
  detail?: string;
  /** Début de la phase en cours. */
  since: number;
  /** Fin d'attente (nouvel essai), pour le compte à rebours. */
  until?: number;
  runStart: number;
  step: number;
  maxSteps: number;
}

/** Bilan du dernier tour de l'agent, affiché tant que rien d'autre ne se passe. */
export interface RunOutcome {
  convId: string;
  kind: "done" | "stopped" | "error" | "limit" | "denied" | "truncated";
  text: string;
  canContinue: boolean;
}

/** Brouillon de la prochaine conversation (avant le premier envoi). */
export interface Draft {
  workspace?: string;
  webSearch: boolean;
  mcp: boolean;
  permissionMode: PermissionMode;
  systemAccess?: boolean;
  projectId?: string;
}

export const state = {
  settings: null as unknown as Settings,
  platform: { os: "linux", shell: "sh", shellPath: "", shellGuidance: "", version: "" },
  keyConfigured: false,
  models: [] as ModelInfo[],
  convs: [] as ConversationSummary[],
  workspaces: [] as string[],
  mcp: [] as McpServerStatus[],
  mode: "chat" as Kind,
  current: null as Conversation | null,
  draft: { webSearch: false, mcp: true, permissionMode: "ask" } as Draft,
  /** Exécution en cours (génération ou outil). */
  busy: null as { requestId: string; msgId: string; stopped: boolean } | null,
  pending: { images: [] as string[], files: [] as TextFile[] },
  selectedModel: "",
  risks: new Map<string, Risk>(),
  approvals: new Map<string, (d: "allow" | "always" | "deny") => void>(),
  activity: null as Activity | null,
  lastRun: null as RunOutcome | null,
  update: null as UpdateInfo | null,
  /** Projet affiché dans la barre latérale ("" = toutes les conversations). */
  projectFilter: "",
  /** Fichiers de consignes (AGENTS.md…) par dossier de projet. */
  instructions: new Map<string, InstructionFile[]>(),
  /** Recherche plein texte : requête et résultats (id → extrait). */
  search: { query: "", hits: new Map<string, string | null>() },
  /** Fichiers de référence préparés pour la dernière question, par conversation. */
  projectCtx: new Map<string, ProjectContext>(),
};

export const uid = () => crypto.randomUUID();

/** Plateforme vue par l'agent : la machine locale, ou le serveur SSH du dossier de projet. */
function platformFor(conv: Conversation): Platform {
  const r = conv.kind === "code" ? parseRemote(conv.workspace) : null;
  if (!r) return state.platform;
  const label = r.host ? `${r.host.label} (${r.host.user ? `${r.host.user}@` : ""}${r.host.host})` : "serveur distant";
  return {
    os: r.host?.system || "Linux/Unix (distant)",
    shell: "bash (ou sh) sur le serveur distant, via SSH",
    shellGuidance: "Use POSIX/bash syntax. Be careful: this may be a production server — never restart services, change system configuration or delete data unless explicitly asked.",
    remote: label,
  };
}

/** Seuil au-delà duquel seuls des extraits sont joints (knowledge::FULL_CONTEXT_CHARS). */
export const FULL_PROJECT_CHARS = 60_000;

function projectFilesFor(conv: Conversation): string | undefined {
  const p = findProject(conv.projectId);
  if (!p) return undefined;
  const ctx = state.projectCtx.get(conv.id);
  if (ctx) return ctx.text;
  // Pas encore préparé (estimation du contexte) : un gros projet n'est jamais joint en entier.
  return projectChars(p) > FULL_PROJECT_CHARS ? "(extraits pertinents sélectionnés à chaque question)" : undefined;
}

/** Invite système complète : consignes du dossier (AGENTS.md…) et projet inclus. */
export const sysPrompt = (conv: Conversation) =>
  systemPrompt(conv, state.settings, platformFor(conv), {
    instructions: conv.kind === "code" && conv.workspace ? state.instructions.get(conv.workspace) : undefined,
    project: findProject(conv.projectId),
    projectFiles: projectFilesFor(conv),
  });

export const errMsg = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

export const modelInfo = (id: string) => state.models.find((m) => m.id === id);
export const defaultModelFor = (kind: Kind) => (kind === "code" ? state.settings.codeModel : state.settings.defaultModel);

/** Dossier de travail du projet, s'il est toujours autorisé. */
export const projectWorkspace = (id?: string | null) => {
  const ws = findProject(id)?.workspace;
  return ws && state.workspaces.includes(ws) ? ws : undefined;
};

/** Options effectives : celles de la conversation ouverte, sinon du brouillon. */
export const opts = () => {
  const c = state.current;
  return {
    kind: c?.kind ?? state.mode,
    workspace: c ? c.workspace : state.draft.workspace,
    webSearch: c ? !!c.webSearch : state.draft.webSearch,
    mcp: c ? c.mcp !== false : state.draft.mcp,
    systemAccess: !!(c ? c.systemAccess : state.draft.systemAccess),
    permissionMode: (c ? c.permissionMode : state.draft.permissionMode) ?? "ask",
    projectId: c ? c.projectId : state.draft.projectId,
  };
};

export const toolCtx = (c: Conversation): ToolContext => ({
  workspace: c.kind === "code" ? c.workspace : undefined,
  web: !!c.webSearch,
  mcp: c.mcp !== false,
  system: c.kind === "code" && !!c.systemAccess,
  project: c.projectId && state.projectCtx.get(c.id)?.mode === "excerpts" ? c.projectId : undefined,
});

export const maxContext = (model: string) => state.models.find((m) => m.id === model)?.maxContextLength ?? null;
