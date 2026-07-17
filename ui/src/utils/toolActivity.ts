/** Reads the model-authored `activity` description off a tool call, when present. */

import type { ToolCall } from "../types/tool-call";

/** The model's own one-line description of what it's doing with this call, or "". */
export function toolActivity(call: ToolCall): string {
  const raw = call.input?.activity;
  return typeof raw === "string" ? raw.trim() : "";
}
