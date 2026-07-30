/** Agent profile — a persona attachable to a chat (name, gradient avatar,
 * prompt template). Mirrors the backend's AgentConfig 1:1. */

/** What the persona does with AgentChat's built-in prompt.
 * - `append` — the built-in prompt stays; the persona is added as the last word.
 * - `replace` — the persona IS the prompt; `{base}` / `{block:…}` pull pieces back. */
export type PromptMode = "append" | "replace";

/** What this agent is allowed to reach for.
 * - `full` — every tool, plus MCP, web search and research.
 * - `memory_only` — remember/recall/forget and nothing else. What makes a
 *   roleplay character work: the tool roster breaks the fiction long before
 *   the model does.
 * - `none` — no tools at all. */
export type ToolPolicy = "full" | "memory_only" | "none";

export interface Agent {
  id: string;
  name: string;
  color_from: string;
  color_to: string;
  /** A template, not literal text: `{date}`, `{tools}`, `{shell}` and friends
   * are substituted on every request, so a persona never goes stale. */
  system_prompt: string;
  prompt_mode: PromptMode;
  /** Built-in prompt sections this agent switches off. Only names the backend
   * lists as toggleable have any effect. */
  disabled_modules: string[];

  // Every field below is optional ON PURPOSE, and must stay that way. They
  // were added after the agent record shipped, and the desktop app bundles a
  // PyInstaller sidecar that can be older than the UI it serves (AGENTS.md,
  // "Don't forget step 2"). Declaring them required makes the compiler agree
  // to `agent.greeting.trim()` — which then throws against any backend that
  // predates the field. Same convention as SettingsData's later additions.

  tool_policy?: ToolPolicy;
  /** Whether this agent keeps facts across chats. */
  memory_enabled?: boolean;
  /** Who the *user* is playing, reachable in the prompt as `{user_persona}`. */
  user_persona?: string;
  /** Opening line, written into the chat verbatim — no model call. */
  greeting?: string;
  /** `null` follows the global setting. */
  temperature?: number | null;
  /** `""` follows whatever the chat header has selected. */
  model?: string;
}

/** One remembered fact. Mirrors the backend's MemoryFact. */
export interface MemoryFact {
  id: number;
  agent_id: string;
  text: string;
  /** Free-form grouping label the model supplied ("user", "plot", …). */
  topic: string;
  /** Pinned facts stay in the always-on block regardless of the budget. */
  pinned: boolean;
  hot_at: number;
  created_at: number;
  hits: number;
  source_chat_id: string | null;
}

/** One entry of the editor's variable palette. */
export interface PromptVariable {
  name: string;
  /** Changes between requests — using it costs prompt caching. */
  volatile: boolean;
}

/** Static editor metadata: the palette and the switchable prompt sections. */
export interface AgentEditorMeta {
  variables: PromptVariable[];
  toggleable_modules: string[];
}

/** What the draft persona would actually produce, assembled by the backend. */
export interface AgentPreview {
  prompt: string;
  active_modules: string[];
  used_variables: string[];
  /** Brace tokens that look like variables but aren't — they ship verbatim. */
  unknown_variables: string[];
  cacheable: boolean;
}
