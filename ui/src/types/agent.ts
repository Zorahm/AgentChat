/** Agent profile — a persona attachable to a chat (name, gradient avatar,
 * optional system-prompt override). Mirrors the backend's AgentConfig 1:1. */

export interface Agent {
  id: string;
  name: string;
  color_from: string;
  color_to: string;
  /** Empty = use AgentChat's built-in dynamic prompt. Non-empty REPLACES it
   * verbatim for every chat using this agent. */
  system_prompt: string;
}
