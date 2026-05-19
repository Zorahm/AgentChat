/** Chat message types — tree-based variant model. */

import type { ToolCall, ProcessStep } from "./tool-call";

// ── Legacy flat message (kept for migration and utility) ───────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  steps?: ProcessStep[];
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
  name: string;
  path: string | null;
  size: number;
  mime_type: string;
  content: string | null;
  data_url: string | null;
}

// ── Tree types (Phase 2+) ──────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface AssistantVariant {
  id: string;
  content: string;
  steps?: ProcessStep[];
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  createdAt: number;
  children: ChatNode[];
}

export interface UserNode {
  id: string;
  role: "user";
  content: string;
  attachments?: AttachmentInfo[];
  createdAt: number;
  child?: AssistantNode;
}

export interface AssistantNode {
  id: string;
  role: "assistant";
  variants: AssistantVariant[];
  activeVariantIdx: number;
}

export type ChatNode = UserNode | AssistantNode;

export interface ChatSession {
  id: string;
  title: string;
  root: ChatNode[];
  createdAt: number;
  /** Working directory slug used by bash_tool: `~/AgentChat/chats/{dirSlug}/`. */
  dirSlug?: string;
}
