/** Tool call display types. */

export type ToolCallStatus = "running" | "success" | "error";

export type ProcessStep =
  | { type: "thought"; content: string }
  | { type: "tool"; call: ToolCall }
  | { type: "text"; content: string }
  | { type: "break" };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
}

export const TOOL_ICONS: Record<string, string> = {
  bash_tool: ">_",
  web_search: "🔍",
  read_file: "📄",
  write_file: "📄",
  read_skill: "📚",
};
