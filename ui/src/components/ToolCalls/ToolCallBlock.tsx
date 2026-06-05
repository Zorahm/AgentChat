/** Collapsible tool call block — three states, Input/Output tabs. */

import { useState } from "react";
import type { ToolCall } from "../../types/tool-call";
import { TOOL_ICONS } from "../../types/tool-call";

interface ToolCallBlockProps {
  call: ToolCall;
  inline?: boolean;
}

/** The one argument worth previewing on the collapsed header, per tool. */
const PREVIEW_ARG: Record<string, string> = {
  bash_tool: "command",
  read_file: "path",
  edit_file: "path",
  read_skill: "name",
  web_search: "query",
  web_fetch: "url",
};

/** Single-line, whitespace-collapsed preview of a tool's primary argument. */
function previewArg(call: ToolCall): string {
  const key = PREVIEW_ARG[call.name];
  const raw = key ? call.input[key] : undefined;
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

export function ToolCallBlock({ call, inline = false }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"input" | "output">("input");

  const icon = TOOL_ICONS[call.name] ?? "🔧";
  const statusClass =
    call.status === "running" ? "tc--running"
    : call.status === "error" ? "tc--error"
    : call.status === "cancelled" ? "tc--cancelled"
    : "tc--success";

  const statusLabel =
    call.status === "running" ? "⟳ running"
    : call.status === "error" ? `✗ error${call.durationMs != null ? ` · ${(call.durationMs / 1000).toFixed(1)}s` : ""}`
    : call.status === "cancelled" ? "⏹ cancelled"
    : `✓ ${call.durationMs != null ? (call.durationMs / 1000).toFixed(1) + "s" : ""}`;

  const inputStr =
    call.input != null ? JSON.stringify(call.input, null, 2) : "";

  const preview = previewArg(call);
  const sigil = call.name === "bash_tool" ? "$ " : "";

  const baseClass = inline
    ? `tc tc--inline ${statusClass}${expanded ? " expanded" : ""}`
    : `tc ${statusClass}${expanded ? " expanded" : ""}`;

  return (
    <div className={baseClass}>
      <div
        className="tc-head"
        onClick={() => setExpanded((v) => !v)}
      >
        {!inline && <span className="tc-icn">{icon}</span>}
        <span className="tc-name">{call.name}</span>
        <span className="tc-status">{statusLabel}</span>
        <span className="tc-chev">{expanded ? "▴" : "▾"}</span>
      </div>

      {!expanded && preview && (
        <div className="tc-preview" title={preview}>
          {sigil}
          {preview}
        </div>
      )}

      {expanded && (
        <div className="tc-body">
          <div className="tc-tabs">
            <button
              className={`tc-tab${tab === "input" ? " active" : ""}`}
              onClick={() => setTab("input")}
            >
              Input
            </button>
            {call.status !== "running" && (
              <button
                className={`tc-tab${tab === "output" ? " active" : ""}`}
                onClick={() => setTab("output")}
              >
                Output
              </button>
            )}
          </div>
          <pre className="tc-pre">
            {tab === "input"
              ? inputStr || "(empty)"
              : call.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}
