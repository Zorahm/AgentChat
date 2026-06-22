/** Tool call display types. */

export type ToolCallStatus = "running" | "success" | "error" | "cancelled";

export type ProcessStep =
  | { type: "thought"; content: string }
  | { type: "tool"; call: ToolCall }
  | { type: "text"; content: string }
  | { type: "break" }
  | { type: "iterations_exhausted"; count: number };

export interface ResearchSource {
  url: string;
  domain: string;
}

/** One node in the research timeline, built live from tool_progress events. */
export type ResearchStep =
  | { kind: "plan"; text?: string }
  | { kind: "search"; query: string; sources: ResearchSource[]; callId?: string }
  | { kind: "read"; url: string };

/** Live state of a `research` tool call — drives the card + the side panel. */
export interface ResearchData {
  title?: string;
  status: "running" | "complete" | "cancelled";
  steps: ResearchStep[];
  startedAt: number;
  durationMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
  filePath?: string;
  /** Present only on `research` tool calls — the timeline of the research run. */
  research?: ResearchData;
}

export const TOOL_ICONS: Record<string, string> = {
  bash_tool: ">_",
  web_search: "🔍",
  web_fetch: "🌐",
  read_file: "📄",
  read_photo: "🖼",
  write_file: "📄",
  edit_file: "📄",
  present_files: "📎",
  read_skill: "📚",
};
