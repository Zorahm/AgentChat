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
  /** Explicitly plain-text user message (no rich editor involved). Disables
   * the legacy "content starts with a tag → render as HTML" heuristic, so a
   * pasted HTML snippet displays as text instead of being injected. Absent on
   * messages from pre-displayHtml builds, where content may really be HTML. */
  plainText?: boolean;
  /** Effective web-search backend for this assistant turn, when search ran. */
  webSearchMode?: string;
  /** Token usage + cost for this assistant turn (backend `usage` SSE event). */
  usage?: MessageUsage;
}

/** Aggregated token/cost totals for one assistant turn, across every LLM call
 * it made (main loop + any research sub-calls). See
 * docs/agentchat-usage-tracking-design.md. */
export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** null when the model isn't in LiteLLM's price map and has no manual
   * `model_pricing` row — shown as "н/д" rather than $0. */
  costUsd: number | null;
  /** "estimated" when usage wasn't reported by the provider and was counted
   * locally instead — shown with a leading "≈" in the UI. */
  usageSource: "api" | "estimated";
  /** Summed LLM call duration for this turn (ms) — null when no call in the
   * turn reported timing. Drives the tokens/sec and elapsed-time display. */
  latencyMs: number | null;
  /** Local, always-estimated split of prompt tokens by source — explains why
   * a short message still billed thousands of tokens (system prompt + tool
   * schemas + prior conversation, not the message itself). Never used for
   * billing, only for the tooltip breakdown. */
  breakdown?: TokenBreakdown;
}

/** Where prompt tokens went, mirroring Claude Code's context-window
 * breakdown where AgentChat has a direct analogue. */
export interface TokenBreakdown {
  system: number;
  /** Project instructions + extracted file text — AgentChat's CLAUDE.md
   * equivalent ("Memory files" in Claude Code). */
  memory: number;
  /** Installed-skills manifest injected into the system prompt. */
  skills: number;
  /** Built-in tool schemas (bash_tool, write_file, ...). */
  tools: number;
  /** MCP server tool schemas. */
  mcpTools: number;
  history: number;
  message: number;
}

export interface AttachmentInfo {
  name: string;
  path: string | null;
  size: number;
  mime_type: string;
  content: string | null;
  data_url: string | null;
}

// ── Tree types ─────────────────────────────────────────────────────────────

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
  /** Token usage + cost for this assistant turn (backend `usage` SSE event). */
  usage?: MessageUsage;
}

export interface UserVariant {
  id: string;
  content: string;
  /** Optional rich-text HTML (tiptap getHTML) preserved for display only. */
  displayHtml?: string;
  /** See ChatMessage.plainText. */
  plainText?: boolean;
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
  /** Agent profile attached to this chat. Empty/undefined = the default agent. */
  agentId?: string;
}
