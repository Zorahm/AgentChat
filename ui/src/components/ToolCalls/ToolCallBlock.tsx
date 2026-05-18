/** Collapsible tool call block — three states, Input/Output tabs. */

import { useState } from "react";
import type { ToolCall } from "../../types/tool-call";
import { TOOL_ICONS } from "../../types/tool-call";

interface ToolCallBlockProps {
  call: ToolCall;
  inline?: boolean;
}

export function ToolCallBlock({ call, inline = false }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"input" | "output">("input");

  const icon = TOOL_ICONS[call.name] ?? "🔧";
  const statusClass =
    call.status === "running" ? "tc--running"
    : call.status === "error" ? "tc--error"
    : "tc--success";

  const statusLabel =
    call.status === "running" ? "⟳ running"
    : call.status === "error" ? `✗ error${call.durationMs != null ? ` · ${(call.durationMs / 1000).toFixed(1)}s` : ""}`
    : `✓ ${call.durationMs != null ? (call.durationMs / 1000).toFixed(1) + "s" : ""}`;

  const inputStr =
    call.input != null ? JSON.stringify(call.input, null, 2) : "";

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
