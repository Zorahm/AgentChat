/** Build artifact cards from `present_files` tool calls.
 *
 * Replaces the old `<artifact />` text tag: the model calls
 * present_files({ paths: [...] }) and each path becomes a viewable /
 * downloadable card in the chat and the side panels. */

import type { Artifact } from "../types/artifact";
import type { ToolCall } from "../types/tool-call";
import { basename } from "./basename";

/** Extract the file paths from one present_files tool call's input. */
function pathsOf(call: ToolCall): string[] {
  const input = call.input ?? {};
  const raw = input.paths ?? input.path;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** Map present_files tool calls to deduplicated file artifacts. */
export function presentedArtifacts(toolCalls: ToolCall[] | undefined): Artifact[] {
  if (!toolCalls) return [];
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== "present_files") continue;
    for (const path of pathsOf(call)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ type: "file", path, label: basename(path) });
    }
  }
  return out;
}
