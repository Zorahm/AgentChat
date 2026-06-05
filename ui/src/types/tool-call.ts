/** Tool call display types. */

export type ToolCallStatus = "running" | "success" | "error" | "cancelled";

export type ProcessStep =
  | { type: "thought"; content: string }
  | { type: "tool"; call: ToolCall }
  | { type: "text"; content: string }
  | { type: "break" }
  | { type: "iterations_exhausted"; count: number };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
  filePath?: string;
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
