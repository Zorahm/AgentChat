/** Multi-session chat manager with tree-based variant model. */

import { useCallback, useEffect, useRef, useState } from "react";
import { sseConnect } from "./useSSE";
import type { SSEEvent, SSEReader } from "./useSSE";
import type {
  ChatMessage,
  ChatNode,
  UserNode,
  AssistantNode,
  AssistantVariant,
  AttachmentInfo,
} from "../types/chat";
import type { ChatSession } from "../types/chat";
import type { ToolCall, ProcessStep } from "../types/tool-call";
import type { LiveFile } from "../types/artifact";
import { API_BASE } from "../utils/apiBase";

// ── Public types ───────────────────────────────────────────────────────────

export type { ChatSession } from "../types/chat";

export interface UseChatResult {
  sessions: ChatSession[];
  activeId: string;
  messages: ChatMessage[];
  branchNodes: ChatNode[];
  liveFiles: LiveFile[];
  isStreaming: boolean;
  error: string | null;
  newChat: () => void;
  switchChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  sendMessage: (text: string, model?: string, attachments?: AttachmentInfo[]) => void;
  retry: () => void;
  switchVariant: (nodeId: string, idx: number) => void;
  abort: () => void;
}

// ── Persistence & migration ────────────────────────────────────────────────

const STORAGE_KEY = "aic-sessions-v2";
const OLD_STORAGE_KEY = "aic-sessions-v1";

interface StoredSession {
  id: string;
  title: string;
  messages?: ChatMessage[];
  root?: ChatNode[];
  createdAt: number;
}

function migrateSession(old: StoredSession): ChatSession {
  const flatMsgs = old.messages ?? [];
  const root: ChatNode[] = [];
  let currentLevel = root;

  for (let i = 0; i < flatMsgs.length; i += 2) {
    const userMsg = flatMsgs[i]!;
    const assistantMsg = flatMsgs[i + 1];

    const userNode: UserNode = {
      id: userMsg.id,
      role: "user",
      content: userMsg.content,
      attachments: userMsg.attachments,
      createdAt: userMsg.timestamp,
    };

    if (assistantMsg) {
      const variant: AssistantVariant = {
        id: assistantMsg.id,
        content: assistantMsg.content,
        steps: assistantMsg.steps,
        toolCalls: assistantMsg.toolCalls,
        reasoningContent: assistantMsg.reasoningContent,
        createdAt: assistantMsg.timestamp,
        children: [],
      };
      const assistantNode: AssistantNode = {
        id: assistantMsg.id,
        role: "assistant",
        variants: [variant],
        activeVariantIdx: 0,
      };
      userNode.child = assistantNode;
      currentLevel.push(userNode, assistantNode);
      currentLevel = variant.children;
    } else {
      currentLevel.push(userNode);
    }
  }

  return { id: old.id, title: old.title, root, createdAt: old.createdAt };
}

function loadStoredSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as StoredSession[];
      if (Array.isArray(data) && data.length > 0 && data[0]!.root) {
        return data as ChatSession[];
      }
    }
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
    if (oldRaw) {
      const oldData = JSON.parse(oldRaw) as StoredSession[];
      if (Array.isArray(oldData)) {
        const migrated = oldData.map(migrateSession);
        persistSessions(migrated);
        localStorage.removeItem(OLD_STORAGE_KEY);
        return migrated;
      }
    }
  } catch {
    /* corrupt storage — start fresh */
  }
  return [];
}

function persistSessions(sessions: ChatSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* quota exceeded */
  }
}

function makeSession(): ChatSession {
  return {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: "New chat",
    root: [],
    createdAt: Date.now(),
  };
}

function deriveTitle(msgs: ChatMessage[]): string {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return "New chat";
  const t = first.content.replace(/\s+/g, " ").trim();
  return t.length > 50 ? t.slice(0, 48) + "\u2026" : t;
}

let nextMsgId = 1;
const newId = () => String(nextMsgId++);

// ── Tree helpers ───────────────────────────────────────────────────────────

/** Walk the active branch and return flat ChatMessage[] for UI. */
function currentBranch(session: ChatSession): ChatMessage[] {
  const out: ChatMessage[] = [];
  let level = session.root;

  while (level.length > 0) {
    for (const node of level) {
      if (node.role === "user") {
        out.push({
          id: node.id,
          role: "user",
          content: node.content,
          timestamp: node.createdAt,
          attachments: node.attachments,
        });
      } else {
        const v = node.variants[node.activeVariantIdx];
        if (!v) break;
        out.push({
          id: node.id,
          role: "assistant",
          content: v.content,
          timestamp: v.createdAt,
          steps: v.steps,
          toolCalls: v.toolCalls,
          reasoningContent: v.reasoningContent,
        });
        level = v.children;
        break;
      }
    }
    if (level.length > 0 && level[level.length - 1]?.role === "user") break;
  }
  return out;
}

/** Walk the active branch and return raw ChatNode[] for variant-aware rendering. */
function currentBranchNodes(session: ChatSession): ChatNode[] {
  const out: ChatNode[] = [];
  let level = session.root;

  while (level.length > 0) {
    for (const node of level) {
      out.push(node);
      if (node.role === "assistant") {
        const v = node.variants[node.activeVariantIdx];
        if (!v) return out;
        level = v.children;
        break;
      }
    }
    if (level.length > 0 && level[level.length - 1]?.role === "user") break;
  }
  return out;
}

interface BranchTail {
  userNode: UserNode | null;
  assistantNode: AssistantNode | null;
  activeVariant: AssistantVariant | null;
}

/** Walk current branch and return the tail nodes. */
function findBranchTail(session: ChatSession): BranchTail {
  let level = session.root;

  while (level.length > 0) {
    let foundAssistant = false;
    for (const node of level) {
      if (node.role === "user") {
        /* walk through */
      } else {
        const v = node.variants[node.activeVariantIdx];
        if (!v) break;
        level = v.children;
        foundAssistant = true;
        break;
      }
    }
    if (!foundAssistant) {
      const last = level[level.length - 1];
      if (last?.role === "user") {
        return { userNode: last, assistantNode: null, activeVariant: null };
      }
      break;
    }
    if (level.length > 0 && level[level.length - 1]?.role === "user" && level.length === 1)
      break;
  }
  return { userNode: null, assistantNode: null, activeVariant: null };
}

/** Return the last assistant node in the active branch (or null). */
function findLastAssistantInBranch(session: ChatSession): {
  nodeId: string;
  variantId: string;
} | null {
  let level = session.root;
  let lastAssistant: { nodeId: string; variantId: string } | null = null;

  while (level.length > 0) {
    for (const node of level) {
      if (node.role === "user") continue;
      const v = node.variants[node.activeVariantIdx];
      if (!v) return lastAssistant;
      lastAssistant = { nodeId: node.id, variantId: v.id };
      level = v.children;
      break;
    }
  }
  return lastAssistant;
}

/** Check if a specific assistant node is the last assistant in the branch. */
function isLastAssistantInBranch(session: ChatSession, nodeId: string): boolean {
  const last = findLastAssistantInBranch(session);
  return last?.nodeId === nodeId;
}

/** Deep-update a specific variant within a session tree. */
function mapVariant(
  session: ChatSession,
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): ChatSession {
  return {
    ...session,
    root: mapNodes(session.root, nodeId, variantId, fn),
  };
}

function mapNodes(
  nodes: ChatNode[],
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): ChatNode[] {
  return nodes.map((node) => {
    if (node.role === "user") {
      if (node.child) return { ...node, child: mapAssistantNode(node.child, nodeId, variantId, fn) };
      return node;
    }
    return mapAssistantNode(node, nodeId, variantId, fn);
  });
}

function mapAssistantNode(
  node: AssistantNode,
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): AssistantNode {
  if (node.id === nodeId) {
    return {
      ...node,
      variants: node.variants.map((v) => (v.id === variantId ? fn(v) : v)),
    };
  }
  return {
    ...node,
    variants: node.variants.map((v) => ({
      ...v,
      children: mapNodes(v.children, nodeId, variantId, fn),
    })),
  };
}

/** Set active variant index on a specific assistant node. */
function setActiveVariant(session: ChatSession, nodeId: string, idx: number): ChatSession {
  return mapSessionNodes(session, (node) =>
    node.role === "assistant" && node.id === nodeId
      ? { ...node, activeVariantIdx: idx }
      : node,
  );
}

function mapSessionNodes(
  session: ChatSession,
  fn: (node: ChatNode) => ChatNode,
): ChatSession {
  return { ...session, root: mapNodesShallow(session.root, fn) };
}

function mapNodesShallow(nodes: ChatNode[], fn: (node: ChatNode) => ChatNode): ChatNode[] {
  return nodes.map((node) => {
    const mapped = fn(node);
    if (mapped !== node) return mapped;
    if (node.role === "user" && node.child) {
      const child = fn(node.child);
      if (child !== node.child) return { ...node, child: child as AssistantNode };
      return { ...node, child: mapAssistantShallow(node.child, fn) };
    }
    if (node.role === "assistant") return mapAssistantShallow(node, fn);
    return node;
  });
}

function mapAssistantShallow(node: AssistantNode, fn: (n: ChatNode) => ChatNode): AssistantNode {
  const variants = node.variants.map((v) => ({
    ...v,
    children: mapNodesShallow(v.children, fn),
  }));
  return { ...node, variants };
}

/** Append a user+assistant pair at the end of the active branch. */
function appendPair(
  session: ChatSession,
  userNode: UserNode,
  assistantNode: AssistantNode,
): ChatSession {
  userNode.child = assistantNode;
  if (session.root.length === 0) {
    return { ...session, root: [userNode, assistantNode] };
  }
  return appendToVariantChildren(session, userNode, assistantNode);
}

function appendToVariantChildren(
  session: ChatSession,
  userNode: UserNode,
  assistantNode: AssistantNode,
): ChatSession {
  const pair: ChatNode[] = [userNode, assistantNode];
  return { ...session, root: appendPairDeep(session.root, pair) };
}

function appendPairDeep(nodes: ChatNode[], pair: ChatNode[]): ChatNode[] {
  if (nodes.length === 0) return pair;
  const last = nodes[nodes.length - 1];
  if (!last) return [...nodes, ...pair];
  if (last.role === "user") {
    const child = last.child;
    if (child) {
      const appended = mapAssistantAppend(child, pair);
      return nodes.map((n) => (n.id === last.id ? { ...n, child: appended } : n));
    }
    return [...nodes, pair[1] as AssistantNode];
  }
  return nodes.map((n) => {
    if (n.role === "user") return n;
    const v = n.variants[n.activeVariantIdx];
    if (!v) return n;
    return {
      ...n,
      variants: n.variants.map((mv, i) =>
        i === n.activeVariantIdx ? { ...mv, children: appendPairDeep(mv.children, pair) } : mv,
      ),
    };
  });
}

function mapAssistantAppend(node: AssistantNode, pair: ChatNode[]): AssistantNode {
  const v = node.variants[node.activeVariantIdx];
  if (!v) return node;
  return {
    ...node,
    variants: node.variants.map((mv, i) =>
      i === node.activeVariantIdx ? { ...mv, children: appendPairDeep(mv.children, pair) } : mv,
    ),
  };
}

/** Add a new empty variant to an assistant node. */
function addVariant(session: ChatSession, nodeId: string): { session: ChatSession; variantId: string } {
  const variantId = newId();
  const variant: AssistantVariant = {
    id: variantId,
    content: "",
    createdAt: Date.now(),
    children: [],
  };
  return {
    session: mapSessionNodes(session, (node) => {
      if (node.role === "assistant" && node.id === nodeId) {
        return {
          ...node,
          variants: [...node.variants, variant],
          activeVariantIdx: node.variants.length,
        };
      }
      return node;
    }),
    variantId,
  };
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useChats(): UseChatResult {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const stored = loadStoredSessions();
    return stored.length ? stored : [makeSession()];
  });

  const [activeId, setActiveId] = useState<string>(() => {
    const stored = loadStoredSessions();
    return stored.length ? stored.at(-1)!.id : "";
  });

  const [liveFiles, setLiveFiles] = useState<LiveFile[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sseRef = useRef<SSEReader | null>(null);
  const streamingTargetRef = useRef<{ nodeId: string; variantId: string } | null>(null);

  useEffect(() => {
    persistSessions(sessions);
  }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const messages = activeSession ? currentBranch(activeSession) : [];
  const branchNodes: ChatNode[] = activeSession ? currentBranchNodes(activeSession) : [];

  // ── SSE handler factory ─────────────────────────────────────────────────

  const updateLiveFile = useCallback(
    (callId: string, updater: (lf: LiveFile) => LiveFile) => {
      setLiveFiles((prev) => prev.map((lf) => (lf.id === callId ? updater(lf) : lf)));
    },
    [],
  );

  const makeEventHandler = useCallback(
    (sessionId: string, nodeId: string, variantId: string) => (event: SSEEvent) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        switch (event.event) {
          case "token": {
            const text = String(data.content ?? "");
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  const last = steps[steps.length - 1];
                  if (last?.type === "text") {
                    steps[steps.length - 1] = { type: "text", content: last.content + text };
                  } else {
                    steps.push({ type: "text", content: text });
                  }
                  return { ...v, content: v.content + text, steps };
                });
              }),
            );
            break;
          }
          case "reasoning": {
            const text = String(data.content ?? "");
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  const last = steps[steps.length - 1];
                  if (last?.type === "thought") {
                    steps[steps.length - 1] = { type: "thought", content: last.content + text };
                  } else {
                    steps.push({ type: "thought", content: text });
                  }
                  return { ...v, steps, reasoningContent: (v.reasoningContent ?? "") + text };
                });
              }),
            );
            break;
          }
          case "reasoning_break": {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  if (steps.length > 0 && steps[steps.length - 1]!.type !== "break") {
                    steps.push({ type: "break" });
                  }
                  return { ...v, steps };
                });
              }),
            );
            break;
          }
          case "tool_start": {
            const tc: ToolCall = {
              id: String(data.id ?? ""),
              name: String(data.name ?? ""),
              input: (data.input as Record<string, unknown>) ?? {},
              status: "running",
            };
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  steps: [...(v.steps ?? []), { type: "tool" as const, call: tc }],
                  toolCalls: [...(v.toolCalls ?? []), tc],
                }));
              }),
            );
            if (tc.name === "write_file" && typeof tc.input.path === "string") {
              const filePath = tc.input.path as string;
              setLiveFiles((prev) => {
                const prior = [...prev].reverse().find((f) => f.path === filePath);
                const base = tc.input["append"] === true ? (prior?.content ?? "") : "";
                return [...prev, { id: tc.id, path: filePath, content: base, done: false }];
              });
            }
            break;
          }
          case "tool_chunk": {
            const callId = String(data.id ?? "");
            const chunk = String(data.content ?? "");
            updateLiveFile(callId, (lf) => ({ ...lf, content: lf.content + chunk }));
            break;
          }
          case "tool_end": {
            const callId = String(data.id ?? "");
            const applyEnd = (tc: ToolCall): ToolCall =>
              tc.id === callId
                ? {
                    ...tc,
                    status: data.success ? "success" : "error",
                    output: String(data.output ?? ""),
                    durationMs: Number(data.duration_ms ?? 0),
                  }
                : tc;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  steps: (v.steps ?? []).map((st) =>
                    st.type === "tool" && st.call.id === callId
                      ? { type: "tool" as const, call: applyEnd(st.call) }
                      : st,
                  ),
                  toolCalls: (v.toolCalls ?? []).map(applyEnd),
                }));
              }),
            );
            updateLiveFile(callId, (lf) => ({ ...lf, done: true }));
            break;
          }
          case "done":
            setIsStreaming(false);
            streamingTargetRef.current = null;
            break;
          case "error":
            setError(String(data.message ?? "Unknown error"));
            setIsStreaming(false);
            streamingTargetRef.current = null;
            break;
        }
      } catch {
        /* ignore malformed */
      }
    },
    [updateLiveFile],
  );

  // ── Public API ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    (content: string, model?: string, attachments?: AttachmentInfo[]) => {
      if ((!content.trim() && (!attachments || attachments.length === 0)) || isStreaming) return;

      sseRef.current?.close();
      setError(null);
      setIsStreaming(true);

      const sid = activeId;
      const currentSession = sessions.find((s) => s.id === sid);
      if (!currentSession) return;

      const userNode: UserNode = {
        id: newId(),
        role: "user",
        content,
        attachments,
        createdAt: Date.now(),
      };

      const assistantNodeId = newId();
      const variantId = newId();
      const variant: AssistantVariant = {
        id: variantId,
        content: "",
        createdAt: Date.now(),
        toolCalls: [],
        children: [],
      };
      const assistantNode: AssistantNode = {
        id: assistantNodeId,
        role: "assistant",
        variants: [variant],
        activeVariantIdx: 0,
      };

      streamingTargetRef.current = { nodeId: assistantNodeId, variantId };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const updated = appendPair(s, userNode, assistantNode);
          const branchMsgs = currentBranch(updated);
          return {
            ...updated,
            title: deriveTitle(branchMsgs),
          };
        }),
      );

      const history: { role: string; content: string }[] = [];
      if (currentSession.root.length > 0) {
        const branch = currentBranch(currentSession);
        for (const m of branch) history.push({ role: m.role, content: m.content });
      }
      history.push({ role: "user", content });

      const handler = makeEventHandler(sid, assistantNodeId, variantId);
      const sse = sseConnect(
        `${API_BASE}/chat`,
        { messages: history, model: model ?? undefined, attachments: attachments ?? undefined },
        handler,
        (err: Error) => {
          setError(err.message);
          setIsStreaming(false);
          streamingTargetRef.current = null;
        },
      );
      sseRef.current = sse;
    },
    [activeId, sessions, isStreaming, makeEventHandler],
  );

  const retry = useCallback(() => {
    if (isStreaming || !activeSession) return;

    const last = findLastAssistantInBranch(activeSession);
    if (!last) return;

    // Find the user message that precedes this assistant
    const branch = currentBranch(activeSession);
    let userContent = "";
    let userAttachments: AttachmentInfo[] | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i];
      if (m!.id === last.nodeId) {
        const prev = branch[i - 1];
        if (prev && prev.role === "user") {
          userContent = prev.content;
          userAttachments = prev.attachments;
        }
        break;
      }
    }

    if (!userContent && (!userAttachments || userAttachments.length === 0)) return;

    sseRef.current?.close();
    setError(null);
    setIsStreaming(true);

    const sid = activeId;
    const { session: updated, variantId } = addVariant(activeSession, last.nodeId);
    streamingTargetRef.current = { nodeId: last.nodeId, variantId };

    setSessions((prev) => prev.map((s) => (s.id === sid ? updated : s)));

    const model = undefined; // retry uses same model as before
    const history: { role: string; content: string }[] = [];
    const currentSess = sessions.find((s) => s.id === sid);
    if (currentSess && currentSess.root.length > 0) {
      const branchMsgs = currentBranch(currentSess);
      for (const m of branchMsgs) {
        if (m.id === last.nodeId) break;
        history.push({ role: m.role, content: m.content });
      }
    }
    history.push({ role: "user", content: userContent });

    const handler = makeEventHandler(sid, last.nodeId, variantId);
    const sse = sseConnect(
      `${API_BASE}/chat`,
      { messages: history, model: model ?? undefined, attachments: userAttachments ?? undefined },
      handler,
      (err: Error) => {
        setError(err.message);
        setIsStreaming(false);
        streamingTargetRef.current = null;
      },
    );
    sseRef.current = sse;
  }, [isStreaming, activeSession, activeId, sessions, makeEventHandler]);

  const switchVariant = useCallback(
    (nodeId: string, idx: number) => {
      if (!activeSession) return;
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? setActiveVariant(s, nodeId, idx) : s)),
      );
    },
    [activeId, activeSession],
  );

  const abort = useCallback(() => {
    const target = streamingTargetRef.current;
    if (target && activeSession) {
      const { nodeId, variantId } = target;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeId) return s;
          return mapVariant(s, nodeId, variantId, (v) => {
            if (v.content.length === 0 && (v.steps?.length ?? 0) === 0) {
              return { ...v, content: "[aborted]" };
            }
            return v;
          });
        }),
      );
    }
    sseRef.current?.close();
    sseRef.current = null;
    streamingTargetRef.current = null;
    setIsStreaming(false);
  }, [activeId, activeSession]);

  const newChat = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    streamingTargetRef.current = null;
    setIsStreaming(false);
    const session = makeSession();
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
    setLiveFiles([]);
    setError(null);
  }, []);

  const switchChat = useCallback(
    (id: string) => {
      if (id === activeId) return;
      sseRef.current?.close();
      sseRef.current = null;
      streamingTargetRef.current = null;
      setIsStreaming(false);
      setActiveId(id);
      setLiveFiles([]);
      setError(null);
    },
    [activeId],
  );

  const deleteChat = useCallback(
    (id: string) => {
      if (id === activeId) {
        sseRef.current?.close();
        sseRef.current = null;
        streamingTargetRef.current = null;
        setIsStreaming(false);
      }
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        if (id === activeId) {
          const next = remaining.at(-1) ?? makeSession();
          setActiveId(next.id);
          setLiveFiles([]);
          setError(null);
          return remaining.length ? remaining : [next];
        }
        return remaining;
      });
    },
    [activeId],
  );

  const renameChat = useCallback(
    (id: string, title: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    },
    [],
  );

  return {
    sessions,
    activeId,
    messages,
    branchNodes,
    liveFiles,
    isStreaming,
    error,
    newChat,
    switchChat,
    deleteChat,
    renameChat,
    sendMessage,
    retry,
    switchVariant,
    abort,
  };
}
