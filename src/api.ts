import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  baseUrl: string;
  defaultModel: string;
  systemPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  theme: "system" | "light" | "dark";
  sendOnEnter: boolean;
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
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string | null;
  messages: Message[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface KeyStatus {
  configured: boolean;
  source: "keyring" | "env" | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; finishReason: string | null; cancelled: boolean };

export interface ApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images: string[];
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

  chat(
    requestId: string,
    request: { model: string; messages: ApiMessage[]; temperature: number | null; maxTokens: number | null },
    onEvent: (e: StreamEvent) => void,
  ): Promise<void> {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("chat_stream", { requestId, request, onEvent: channel });
  },
};
