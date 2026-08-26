/** TEMPORARY debug harness for visually verifying live tool-argument streaming.
 * Not part of the app — rendered only behind ?debug-toolstream, since a real run
 * needs a provider. It replays the backend's own event vocabulary
 * (tool_start / tool_input_delta / tool_input, see backend/agent/tool_stream.py)
 * through the same append the SSE handler does, so what you see is exactly what
 * a live turn produces. */
import { useEffect, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { MessageBubble } from "./components/Chat/MessageBubble";
import type { ChatMessage } from "./types/chat";
import type { ProcessStep, ToolCall } from "./types/tool-call";

interface Script {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, string>;
}

const SCRIPTS: Script[] = [
  {
    id: "t-bash",
    name: "bash_tool",
    args: { command: "for f in *.py; do echo \"== $f\"; wc -l \"$f\"; done | sort -k2 -n" },
  },
  { id: "t-list", name: "list_dir", args: { path: "/home/u/AgentChat/chats/chat-a1b2/src" } },
  {
    id: "t-mcp",
    name: "mcp__notion__search_pages",
    args: { query: "roadmap Q3 planning", filter: "page" },
  },
  {
    id: "t-edit",
    name: "edit_file",
    args: {
      path: "/home/u/chat/app.py",
      old_string: "def handler(req):\n    return None",
      new_string: "def handler(req):\n    return Response(200)",
    },
  },
  {
    id: "t-widget",
    name: "show_widget",
    args: {
      title: "Revenue by quarter",
      html: "<div class=\"chart\">\n".repeat(120) + "<canvas id=\"c\"></canvas>",
    },
  },
];

/** One in-flight call, revealed up to *fraction* of each argument — the shape a
 *  half-typed call actually has mid-stream. */
function partial(script: Script, fraction: number): ToolCall {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(script.args)) {
    const cut = Math.floor(value.length * fraction);
    if (cut > 0) input[key] = value.slice(0, cut);
  }
  return { id: `${script.id}-${fraction}`, name: script.name, input, status: "running" };
}

function message(id: string, calls: ToolCall[]): ChatMessage {
  const steps: ProcessStep[] = calls.map((call) => ({ type: "tool", call }));
  return { id, role: "assistant", content: "", timestamp: Date.now(), steps, toolCalls: calls };
}

/** Replays the deltas on a timer, so the preview can be watched growing. */
function useTyping(script: Script, speed = 12): ToolCall {
  const [chars, setChars] = useState(0);
  const total = Object.values(script.args).join("").length;
  useEffect(() => {
    const timer = setInterval(() => setChars((n) => (n >= total ? 0 : n + speed)), 60);
    return () => clearInterval(timer);
  }, [total, speed]);

  // Same append the SSE handler performs: each delta extends one argument.
  const input: Record<string, unknown> = {};
  let budget = chars;
  for (const [key, value] of Object.entries(script.args)) {
    if (budget <= 0) break;
    input[key] = value.slice(0, budget);
    budget -= value.length;
  }
  return { id: script.id, name: script.name, input, status: "running" };
}

export function DebugToolStreamHarness() {
  const typingBash = useTyping(SCRIPTS[0]!);
  const typingWidget = useTyping(SCRIPTS[4]!, 60);

  return (
    <Theme theme={neutralTheme}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 32, maxWidth: 900 }}>
        <h2>Typing live (loops)</h2>
        <MessageBubble message={message("m-live", [typingBash, typingWidget])} isGlobalStreaming />

        <h2>Mid-stream snapshots</h2>
        <MessageBubble
          message={message("m-25", SCRIPTS.map((s) => partial(s, 0.25)))}
          isGlobalStreaming
        />

        <h2>Nearly complete</h2>
        <MessageBubble
          message={message("m-90", SCRIPTS.map((s) => partial(s, 0.9)))}
          isGlobalStreaming
        />

        <h2>Failed calls (red cross, expandable input/output)</h2>
        <MessageBubble
          message={message("m-failed", [
            {
              id: "fail-write",
              name: "write_file",
              input: { path: "/etc/passwd", content: "root:x:0:0" },
              status: "error",
              durationMs: 8,
              output: "Error: Sandbox: writes are only allowed inside the chat folder (/home/u/chat).",
            },
            {
              id: "fail-bash",
              name: "bash_tool",
              input: { command: "pip install nonexistent-package-xyz\necho done" },
              status: "error",
              durationMs: 2400,
              output:
                "ERROR: Could not find a version that satisfies the requirement nonexistent-package-xyz\n[stderr]\nERROR: No matching distribution found\n[exit code: 1]",
            },
          ])}
        />

        <h2>Finished bash (two tabs)</h2>
        <MessageBubble
          message={message("m-bash-ok", [
            {
              id: "ok-bash",
              name: "bash_tool",
              input: {
                command:
                  "for f in *.py; do\n  echo \"== $f\"\n  wc -l \"$f\"\ndone | sort -k2 -n | head -20",
              },
              status: "success",
              durationMs: 340,
              output: "== main.py\n  120 main.py\n== utils.py\n   88 utils.py",
            },
          ])}
        />

        <h2>Finished (output replaces the live input)</h2>
        <MessageBubble
          message={message("m-done", [
            {
              id: "done-list",
              name: "list_dir",
              input: { path: "/home/u/chat/src", depth: 1 },
              status: "success",
              durationMs: 42,
              output: "[/home/u/chat/src — 3 entries]\n\ncomponents/\nmain.py  4.2 KB\nutils.py  812 B",
            },
          ])}
        />
      </div>
    </Theme>
  );
}
