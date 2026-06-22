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
  /** Rich-text HTML for user bubbles (tiptap getHTML). Display-only — `content`
   * stays plain text for title derivation, copy, retry, and backend history. */
  displayHtml?: string;
  /** Effective web-search backend for this assistant turn, when search ran. */
  webSearchMode?: string;
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
  /** Effective web-search backend for this turn (native|litellm|searxng),
   * reported by the backend's web_search_status event. Drives the indicator. */
  webSearchMode?: string;
}

export interface UserVariant {
  id: string;
  content: string;
  /** Optional rich-text HTML (tiptap getHTML) preserved for display only. */
  displayHtml?: string;
  attachments?: AttachmentInfo[];
  createdAt: number;
  child?: AssistantNode;
}

export interface UserNode {
  id: string;
  role: "user";
  /** All edits of this message slot. The original is variants[0]; each edit
   * appends a new variant carrying its own assistant subtree under `child`. */
  variants: UserVariant[];
  activeVariantIdx: number;
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
  /** Last activity timestamp (ms). Used for "Last message …" labels. */
  updatedAt?: number;
  /** Working directory slug used by bash_tool: `~/AgentChat/chats/{dirSlug}/`. */
  dirSlug?: string;
  /** Client-side pin flag — stored in localStorage, not synced to backend. */
  pinned?: boolean;
  /** IDs of MCP servers enabled for this chat. Empty = no MCP. */
  mcpEnabledServers?: string[];
  /** Per-chat web search toggle (globe button). */
  webSearchEnabled?: boolean;
  /** Requested web search mode: auto|native|litellm|searxng. Default "auto". */
  webSearchMode?: string;
  /** Per-chat research toggle (deep multi-step web research → report.md). */
  researchEnabled?: boolean;
  /** Project this chat belongs to. Empty/undefined = standalone chat. */
  projectId?: string;
}
