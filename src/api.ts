import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  baseUrl: string;
  defaultModel: string;
  systemPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  theme: "system" | "light" | "dark";
  sendOnEnter: boolean;
  webSearchProvider: "mistral" | "searxng";
  searxngUrl: string;
  webSearchDefault: boolean;
  pdfMode: "auto" | "local" | "ocr";
  codeModel: string;
  commandTimeout: number;
  mcpAlwaysAllow: string[];
}

export interface ModelInfo {
  id: string;
  description: string | null;
  vision: boolean;
  maxContextLength: number | null;
}

export interface TextFile {
  name: string;
  text: string;
}

export type ToolStatus = "queued" | "pending" | "running" | "done" | "error" | "denied";

export interface ToolCallRec {
  id: string;
  name: string;
  arguments: string;
  status: ToolStatus;
  result?: string;
  diff?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  images?: string[];
  files?: TextFile[];
  reasoning?: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
  cancelled?: boolean;
  toolCalls?: ToolCallRec[];
}

export type Kind = "chat" | "code";
export type PermissionMode = "ask" | "acceptEdits" | "auto";

export interface Conversation {
  id: string;
  title: string;
  kind: Kind;
  model: string;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string | null;
  messages: Message[];
  workspace?: string;
  permissionMode?: PermissionMode;
  webSearch?: boolean;
  mcp?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  kind: Kind;
  workspace: string | null;
}

export interface KeyStatus {
  configured: boolean;
  source: "keyring" | "env" | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "toolCalls"; calls: { id: string; name: string; arguments: string }[] }
  | { type: "done"; finishReason: string | null; cancelled: boolean };

export interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  name?: string;
}

export interface ToolContext {
  workspace?: string;
  web: boolean;
  mcp: boolean;
}

export type Risk = "read" | "write" | "exec" | "mcp";

export interface ToolDef {
  definition: { type: "function"; function: { name: string; description: string; parameters: unknown } };
  risk: Risk;
}

export interface ToolOutput {
  content: string;
  isError: boolean;
  diff: string | null;
}

export interface McpServerStatus {
  name: string;
  state: "starting" | "ready" | "error" | "disabled";
  error: string | null;
  transport: "stdio" | "http";
  protocol: string | null;
  tools: { exposed: string; name: string; description: string }[];
}

export const api = {
  keyStatus: () => invoke<KeyStatus>("api_key_status"),
  setKey: (key: string) => invoke<void>("set_api_key", { key }),
  deleteKey: () => invoke<void>("delete_api_key"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  listModels: () => invoke<ModelInfo[]>("list_models"),
  listConversations: () => invoke<ConversationSummary[]>("list_conversations"),
  loadConversation: (id: string) => invoke<Conversation>("load_conversation", { id }),
  saveConversation: (conversation: Conversation) => invoke<void>("save_conversation", { conversation }),
  deleteConversation: (id: string) => invoke<void>("delete_conversation", { id }),
  exportConversation: (id: string) => invoke<boolean>("export_conversation", { id }),
  dataDir: () => invoke<string>("data_dir"),
  cancel: (requestId: string) => invoke<void>("cancel_stream", { requestId }),
  platform: () => invoke<{ os: string; shell: string }>("platform_info"),

  toolDefinitions: (ctx: ToolContext) => invoke<ToolDef[]>("tool_definitions", { ctx }),
  previewTool: (ctx: ToolContext, name: string, args: string) =>
    invoke<string | null>("preview_tool", { ctx, name, arguments: args }),
  runTool: (requestId: string, ctx: ToolContext, name: string, args: string) =>
    invoke<ToolOutput>("run_tool", { requestId, ctx, name, arguments: args }),

  pickWorkspace: () => invoke<string | null>("pick_workspace"),
  listWorkspaces: () => invoke<string[]>("list_workspaces"),
  forgetWorkspace: (path: string) => invoke<string[]>("forget_workspace", { path }),
  touchWorkspace: (path: string) => invoke<void>("touch_workspace", { path }),

  processDocument: (name: string, dataBase64: string) =>
    invoke<{ text: string; method: "local" | "ocr" }>("process_document", { name, dataBase64 }),

  mcpGetConfig: () => invoke<string>("mcp_get_config"),
  mcpSaveConfig: (text: string) => invoke<void>("mcp_save_config", { text }),
  mcpRestart: () => invoke<void>("mcp_restart"),
  mcpStatus: () => invoke<McpServerStatus[]>("mcp_status"),

  chat(
    requestId: string,
    request: {
      model: string;
      messages: ApiMessage[];
      temperature: number | null;
      maxTokens: number | null;
      tools: ToolDef["definition"][];
    },
    onEvent: (e: StreamEvent) => void,
  ): Promise<void> {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("chat_stream", { requestId, request, onEvent: channel });
  },
};
