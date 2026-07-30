/** Agent profile — a persona attachable to a chat (name, gradient avatar,
 * prompt template). Mirrors the backend's AgentConfig 1:1. */

/** What the persona does with AgentChat's built-in prompt.
 * - `append` — the built-in prompt stays; the persona is added as the last word.
 * - `replace` — the persona IS the prompt; `{base}` / `{block:…}` pull pieces back. */
export type PromptMode = "append" | "replace";

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
