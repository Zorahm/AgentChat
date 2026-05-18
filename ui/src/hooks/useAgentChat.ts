/** Core chat hook — manages messages, tool calls, SSE streaming. */

import { useCallback, useRef, useState } from "react";
import type { SSEEvent, SSEReader } from "./useSSE";
import { sseConnect } from "./useSSE";
import type { ChatMessage } from "../types/chat";
import type { ToolCall } from "../types/tool-call";
import type { LiveFile } from "../types/artifact";
import { API_BASE } from "../utils/apiBase";

let nextId = 1;

export interface AgentChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  liveFiles: LiveFile[];
  error: string | null;
}

export function useAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveFiles, setLiveFiles] = useState<LiveFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sseRef = useRef<SSEReader | null>(null);

  const state: AgentChatState = { messages, isStreaming, liveFiles, error };

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateLastAssistant = useCallback(
    (updater: (msg: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const idx = lastAssistantIndex(prev);
        if (idx < 0) return prev;
        const updated = [...prev];
        updated[idx] = updater(updated[idx]!);
        return updated;
      });
    },
    [],
  );

  const sendMessage = useCallback(
    (content: string, model?: string) => {
      if (!content.trim() || isStreaming) return;

      sseRef.current?.close();
      setError(null);

      const userMsg: ChatMessage = {
        id: String(nextId++),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      addMessage(userMsg);

      const assistantMsg: ChatMessage = {
        id: String(nextId++),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        toolCalls: [],
      };
      addMessage(assistantMsg);
      setIsStreaming(true);

      // Build conversation history for the backend
      const allMessages = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const sse = sseConnect(
        `${API_BASE}/chat`,
        { messages: allMessages, model: model ?? undefined },
        (event: SSEEvent) => {
          try {
            const data = JSON.parse(event.data);
            handleSSEEvent(event.event, data);
          } catch {
            // ignore malformed SSE data
          }
        },
        (err: Error) => {
          setError(err.message);
          setIsStreaming(false);
        },
      );

      sseRef.current = sse;
    },
    [messages, isStreaming, addMessage],
  );

  function handleSSEEvent(type: string, data: Record<string, unknown>) {
    switch (type) {
      case "token": {
        const text = String(data.content ?? "");
        updateLastAssistant((msg) => {
          const steps = [...(msg.steps ?? [])];
          const last = steps[steps.length - 1];
          if (last?.type === "text") {
            steps[steps.length - 1] = { type: "text", content: last.content + text };
          } else {
            steps.push({ type: "text", content: text });
          }
          return { ...msg, content: msg.content + text, steps };
        });
        break;
      }
      case "reasoning": {
        const text = String(data.content ?? "");
        updateLastAssistant((msg) => {
          const steps = [...(msg.steps ?? [])];
          const last = steps[steps.length - 1];
          if (last?.type === "thought") {
            steps[steps.length - 1] = { type: "thought", content: last.content + text };
          } else {
            steps.push({ type: "thought", content: text });
          }
          return { ...msg, steps, reasoningContent: (msg.reasoningContent ?? "") + text };
        });
        break;
      }
      case "reasoning_break": {
        updateLastAssistant((msg) => {
          const steps = [...(msg.steps ?? [])];
          if (steps.length > 0 && steps[steps.length - 1]!.type !== "break") {
            steps.push({ type: "break" });
          }
          return { ...msg, steps };
        });
        break;
      }
      case "tool_start": {
        const tc: ToolCall = {
          id: String(data.id ?? ""),
          name: String(data.name ?? ""),
          input: (data.input as Record<string, unknown>) ?? {},
          status: "running",
        };
        updateLastAssistant((msg) => ({
          ...msg,
          steps: [...(msg.steps ?? []), { type: "tool" as const, call: tc }],
          toolCalls: [...(msg.toolCalls ?? []), tc],
        }));
        if (tc.name === "write_file" && typeof tc.input.path === "string") {
          const lf: LiveFile = { id: tc.id, path: tc.input.path, content: "", done: false };
          setLiveFiles((prev) => [...prev, lf]);
        }
        break;
      }
      case "tool_end": {
        const callId = String(data.id ?? "");
        const applyEnd = (tc: ToolCall): ToolCall =>
          tc.id === callId
            ? { ...tc, status: data.success ? "success" : "error", output: String(data.output ?? ""), durationMs: Number(data.duration_ms ?? 0) }
            : tc;
        updateLastAssistant((msg) => ({
          ...msg,
          steps: (msg.steps ?? []).map((s) =>
            s.type === "tool" && s.call.id === callId
              ? { type: "tool" as const, call: applyEnd(s.call) }
              : s,
          ),
          toolCalls: (msg.toolCalls ?? []).map(applyEnd),
        }));
        setLiveFiles((prev) => prev.map((lf) => lf.id === callId ? { ...lf, done: true } : lf));
        break;
      }
      case "done": {
        setIsStreaming(false);
        break;
      }
      case "error": {
        setError(String(data.message ?? "Unknown error"));
        setIsStreaming(false);
        break;
      }
    }
  }

  const clearChat = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    setMessages([]);
    setLiveFiles([]);
    setError(null);
    setIsStreaming(false);
  }, []);

  const abort = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    setIsStreaming(false);
  }, []);

  return { ...state, sendMessage, clearChat, abort };
}

function lastAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return i;
  }
  return -1;
}
