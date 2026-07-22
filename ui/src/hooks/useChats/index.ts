/** Multi-session chat manager with tree-based variant model. */

import { useCallback, useEffect, useRef, useState } from "react";
import { sseConnect } from "../useSSE";
import type { SSEEvent, SSEReader } from "../useSSE";
import type {
  ChatMessage,
  ChatNode,
  UserNode,
  UserVariant,
  AssistantNode,
  AssistantVariant,
  AttachmentInfo,
} from "../../types/chat";
import type { ChatSession } from "../../types/chat";
import type { ToolCall, ProcessStep } from "../../types/tool-call";
import type { LiveFile } from "../../types/artifact";
import { API_BASE } from "../../utils/apiBase";
import { applyResearchEvent } from "../../utils/research";
import {
  type WebSearchPref,
  type SessionSeed,
  loadPinnedIds,
  savePinnedIds,
  makeSession,
  makeDirSlug,
  deriveTitle,
  isDefaultTitle,
  newId,
  SAVE_DEBOUNCE_MS,
  getWebSearchDefault,
  setWebSearchDefaultState,
  getResearchDefault,
  setResearchDefaultState,
  getThinkingDefault,
  setThinkingDefaultState,
  getEffortDefault,
  setEffortDefaultState,
} from "./persistence";
import {
  fetchChatList,
  fetchChatFull,
  createChatRemote,
  putChatRemote,
  deleteChatRemote,
  maybeMigrateLocalStorage,
  snapshot,
} from "./api";
import {
  currentBranch,
  currentBranchNodes,
  type WireMessage,
  expandToWire,
  findLastAssistantInBranch,
  mapVariant,
  setActiveVariant,
  appendPair,
  addVariant,
  addUserVariant,
  setUserVariantChild,
} from "./tree";
import { isGhostChat, buildGhostSystemMessage, createGhostChatSession } from "./easterEgg";

// ── Public types ───────────────────────────────────────────────────────────

export type { ChatSession } from "../../types/chat";
export type { SessionSeed } from "./persistence";
export { makeDirSlug, getWebSearchDefault, getResearchDefault };

export interface AgentChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  liveFiles: LiveFile[];
  error: string | null;
}

export interface UseChatResult {
  sessions: ChatSession[];
  activeId: string;
  activeDirSlug: string | null;
  activeMcpEnabled: string[];
  messages: ChatMessage[];
  branchNodes: ChatNode[];
  liveFiles: LiveFile[];
  isStreaming: boolean;
  /** Every chat currently streaming — drives per-chat "working" indicators. */
  streamingIds: ReadonlySet<string>;
  error: string | null;
  newChat: (projectId?: string) => void;
  startProjectChat: (
    projectId: string,
    text: string,
    model?: string,
    attachments?: AttachmentInfo[],
    html?: string,
    dirSlug?: string,
    seed?: SessionSeed,
  ) => void;
  switchChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  pinChat: (id: string) => void;
  sendMessage: (text: string, model?: string, attachments?: AttachmentInfo[], html?: string, thinkingEnabled?: boolean, effort?: string) => void;
  retry: () => void;
  editMessage: (userNodeId: string, content: string, displayHtml?: string) => void;
  switchVariant: (nodeId: string, idx: number) => void;
  abort: () => void;
  startGhostChat: () => void;
  toggleMcpServer: (serverId: string) => void;
  activeWebSearchEnabled: boolean;
  activeWebSearchMode: string;
  setWebSearch: (enabled: boolean, mode?: string) => void;
  /** Mirror the persisted web-search default (from /api/settings) into the hook
   *  so the composer toggle reflects it on load and survives app restarts. */
  setWebSearchDefault: (pref: Partial<WebSearchPref>) => void;
  activeResearchEnabled: boolean;
  setResearch: (enabled: boolean) => void;
  /** Mirror the persisted research default (from /api/settings) into the hook. */
  setResearchDefault: (enabled: boolean) => void;
  /** Mirror the live thinking / effort composer toggles so retry/edit/project
   *  sends reuse them instead of falling back to the model's defaults. */
  setThinkingDefault: (enabled: boolean) => void;
  setEffortDefault: (effort: string | null) => void;
  /** Agent profile attached to the active chat ("default" when unset). */
  activeAgentId: string;
  setAgent: (agentId: string) => void;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useChats(): UseChatResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [liveFiles, setLiveFiles] = useState<LiveFile[]>([]);
  // Reactive mirror of the sticky web-search default. Held as state so the
  // composer toggle re-renders the moment App pushes the persisted setting in;
  // synced to the module-level default (read by makeSession + the send path)
  // via the effect below.
  const [wsDefault, setWsDefault] = useState<WebSearchPref>(getWebSearchDefault());
  useEffect(() => { setWebSearchDefaultState(wsDefault); }, [wsDefault]);
  const setWebSearchDefault = useCallback((pref: Partial<WebSearchPref>) => {
    setWsDefault({
      enabled: !!pref.enabled,
      mode: typeof pref.mode === "string" ? pref.mode : "auto",
    });
  }, []);
  // Reactive mirror of the sticky research default (same pattern as wsDefault).
  const [rDefault, setRDefault] = useState<boolean>(getResearchDefault());
  useEffect(() => { setResearchDefaultState(rDefault); }, [rDefault]);
  const setResearchDefault = useCallback((enabled: boolean) => {
    setRDefault(!!enabled);
  }, []);
  // Thinking/effort live in App's state and only feed the composer, so the hook
  // needs no reactive copy — just keep the module-level mirror current for the
  // send/retry/edit paths to read synchronously.
  const setThinkingDefault = useCallback((enabled: boolean) => {
    setThinkingDefaultState(!!enabled);
  }, []);
  const setEffortDefault = useCallback((effort: string | null) => {
    setEffortDefaultState(typeof effort === "string" ? effort : null);
  }, []);
  /** Ids of every chat currently streaming. Many can run at once — opening a new
   *  chat or jumping to settings never interrupts a reply already in flight. */
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** Live SSE readers keyed by session id, with the assistant node each is
   *  writing into (used by abort to mark the right variant). */
  const streamsRef = useRef<Map<string, { reader: SSEReader; nodeId: string; variantId: string }>>(new Map());
  /** Mirror of activeId, readable inside event-handler closures (which capture a
   *  fixed sessionId) so they can tell whether their chat is the one on screen. */
  const activeIdRef = useRef<string>("");
  const initializedRef = useRef(false);
  /** Per-session JSON snapshot of the last value pushed to the backend. The
   * effect that debounces saves compares against this to skip no-op writes. */
  const lastSavedRef = useRef<Map<string, string>>(new Map());
  /** Per-session pending save timer. */
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** First message queued by startProjectChat, fired once the new chat is active. */
  const pendingSendRef = useRef<{
    sessionId: string;
    content: string;
    model?: string;
    attachments?: AttachmentInfo[];
    html?: string;
  } | null>(null);

  // Keep the activeId mirror current for event-handler closures.
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  /** Register a freshly-opened SSE stream for a session. */
  const beginStream = useCallback(
    (sid: string, reader: SSEReader, nodeId: string, variantId: string) => {
      streamsRef.current.set(sid, { reader, nodeId, variantId });
      setStreamingIds((prev) => {
        if (prev.has(sid)) return prev;
        const next = new Set(prev);
        next.add(sid);
        return next;
      });
    },
    [],
  );

  /** Tear a stream down. close=true aborts the live connection (abort / delete);
   *  a natural done/error passes close=false since the reader already finished. */
  const dropStream = useCallback((sid: string, close: boolean) => {
    const handle = streamsRef.current.get(sid);
    if (handle && close) {
      try { handle.reader.close(); } catch { /* already closed */ }
    }
    streamsRef.current.delete(sid);
    setStreamingIds((prev) => {
      if (!prev.has(sid)) return prev;
      const next = new Set(prev);
      next.delete(sid);
      return next;
    });
  }, []);

  // ── Initial load + one-shot migration ─────────────────────────────────
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    (async () => {
      await maybeMigrateLocalStorage();
      const pinnedIds = loadPinnedIds();
      const remote = await fetchChatList();
      if (remote.length === 0) {
        const fresh = makeSession();
        const created = await createChatRemote(fresh);
        setSessions([created]);
        setActiveId(created.id);
        lastSavedRef.current.set(created.id, snapshot(created));
        return;
      }
      // Lazy-load: fetch the most recently updated chat's full tree right away
      // so the user sees something on first paint. Other chats are loaded on switch.
      const active = remote[0]!;
      const full = await fetchChatFull(active.id);
      const hydrated = remote.map((s) => ({
        ...(s.id === active.id && full ? full : s),
        pinned: pinnedIds.has(s.id),
      }));
      setSessions(hydrated);
      setActiveId(active.id);
      for (const s of hydrated) {
        lastSavedRef.current.set(s.id, snapshot(s));
      }
    })();
  }, []);

  // ── Debounced auto-save ───────────────────────────────────────────────
  useEffect(() => {
    for (const s of sessions) {
      const snap = snapshot(s);
      if (lastSavedRef.current.get(s.id) === snap) continue;
      const existing = saveTimersRef.current.get(s.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        // Read latest from closure — but we need fresh state, so look it up
        // via the snapshot. We persist whatever the sessions array carries at
        // schedule time; that's stale-by-one-batch at worst, fine for autosave.
        void putChatRemote(s).then(() => {
          lastSavedRef.current.set(s.id, snap);
          saveTimersRef.current.delete(s.id);
        });
      }, SAVE_DEBOUNCE_MS);
      saveTimersRef.current.set(s.id, timer);
    }
  }, [sessions]);

  // Flush pending saves on unload (best-effort; navigator.sendBeacon doesn't
  // help here because PUT body is JSON — but the browser may still complete
  // the fetch if we don't await).
  useEffect(() => {
    const flush = () => {
      for (const [id, timer] of saveTimersRef.current.entries()) {
        clearTimeout(timer);
        const s = sessions.find((x) => x.id === id);
        if (s) void putChatRemote(s);
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  // The composer/stop-button only care about the chat on screen.
  const isStreaming = streamingIds.has(activeId);
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
                  if (last?.type === "text") {
                    steps.push({ type: "break" });
                  }
                  const tail = steps[steps.length - 1];
                  if (tail?.type === "thought") {
                    steps[steps.length - 1] = { type: "thought", content: tail.content + text };
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
            // Ignore - breaks are now only inserted when text precedes reasoning/tool_start
            break;
          }
          case "web_search_status": {
            const mode = String(data.mode ?? "");
            if (mode && mode !== "none") {
              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== sessionId) return s;
                  return mapVariant(s, nodeId, variantId, (v) => ({ ...v, webSearchMode: mode }));
                }),
              );
            }
            break;
          }
          case "tool_start": {
            const toolName = String(data.name ?? "");
            const tc: ToolCall = {
              id: String(data.id ?? ""),
              name: toolName,
              input: (data.input as Record<string, unknown>) ?? {},
              status: "running",
              ...(toolName === "research"
                ? { research: { status: "running" as const, steps: [], startedAt: Date.now() } }
                : {}),
            };
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  const last = steps[steps.length - 1];
                  if (last?.type === "text") {
                    steps.push({ type: "break" });
                  }
                  steps.push({ type: "tool" as const, call: tc });
                  return { ...v, steps, toolCalls: [...(v.toolCalls ?? []), tc] };
                });
              }),
            );
            if (sessionId === activeIdRef.current && tc.name === "write_file" && typeof tc.input.path === "string") {
              const filePath = tc.input.path as string;
              setLiveFiles((prev) => {
                const prior = [...prev].reverse().find((f) => f.path === filePath);
                const base = tc.input["append"] === true ? (prior?.content ?? "") : "";
                return [...prev, { id: tc.id, path: filePath, content: base, done: false }];
              });
            }
            break;
          }
          case "tool_input": {
            // Live refresh of a running tool's input — the model is still
            // typing the arguments (e.g. the bash command appears char by char).
            const callId = String(data.id ?? "");
            const input = (data.input as Record<string, unknown>) ?? {};
            const applyInput = (tc: ToolCall): ToolCall =>
              tc.id === callId ? { ...tc, input: { ...tc.input, ...input } } : tc;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  steps: (v.steps ?? []).map((st) =>
                    st.type === "tool" && st.call.id === callId
                      ? { type: "tool" as const, call: applyInput(st.call) }
                      : st,
                  ),
                  toolCalls: (v.toolCalls ?? []).map(applyInput),
                }));
              }),
            );
            break;
          }
          case "tool_chunk": {
            const callId = String(data.id ?? "");
            const chunk = String(data.content ?? "");
            if (sessionId === activeIdRef.current) {
              updateLiveFile(callId, (lf) => ({ ...lf, content: lf.content + chunk }));
            }
            break;
          }
          case "tool_progress": {
            // Structured progress from a streaming tool (research) — fold the
            // event into that tool call's research timeline.
            const callId = String(data.id ?? "");
            const event = (data.event as Record<string, unknown>) ?? {};
            const applyEvent = (tc: ToolCall): ToolCall =>
              tc.id === callId && tc.research
                ? { ...tc, research: applyResearchEvent(tc.research, event) }
                : tc;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  toolCalls: (v.toolCalls ?? []).map(applyEvent),
                  steps: (v.steps ?? []).map((st) =>
                    st.type === "tool" ? { type: "tool" as const, call: applyEvent(st.call) } : st,
                  ),
                }));
              }),
            );
            break;
          }
          case "user_question": {
            // Agent asked the user a question via ask_user tool. Store the
            // question data on the tool call so the UI can render a question card.
            const callId = String(data.id ?? "");
            const chatId = String(data.chat_id ?? "");
            const questions = (data.questions as Array<{ question: string; options: string[] }>) ?? [];
            const selectionType = String(data.selection_type ?? "single") as "single" | "multiple";
            const uqData = { chatId, questions, selectionType };
            const applyQuestion = (tc: ToolCall): ToolCall =>
              tc.id === callId ? { ...tc, userQuestion: uqData } : tc;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  toolCalls: (v.toolCalls ?? []).map(applyQuestion),
                  steps: (v.steps ?? []).map((st) =>
                    st.type === "tool" ? { type: "tool" as const, call: applyQuestion(st.call) } : st,
                  ),
                }));
              }),
            );
            break;
          }
          case "tool_end": {
            const callId = String(data.id ?? "");
            const filePath = typeof data.file_path === "string" ? data.file_path : undefined;
            const applyEnd = (tc: ToolCall): ToolCall =>
              tc.id === callId
                ? {
                    ...tc,
                    status: data.success ? "success" : "error",
                    output: String(data.output ?? ""),
                    durationMs: Number(data.duration_ms ?? 0),
                    ...(filePath ? { filePath } : {}),
                    ...(tc.research
                      ? {
                          research: {
                            ...tc.research,
                            status: "complete" as const,
                            durationMs: Number(data.duration_ms ?? 0),
                          },
                        }
                      : {}),
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
            if (sessionId === activeIdRef.current) {
              updateLiveFile(callId, (lf) => ({ ...lf, done: true }));
            }
            break;
          }
          case "iterations_exhausted": {
            const count = Number(data.count ?? 0);
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  steps: [...(v.steps ?? []), { type: "iterations_exhausted" as const, count }],
                }));
              }),
            );
            break;
          }
          case "usage": {
            const rawBreakdown = data.breakdown as Record<string, number> | null | undefined;
            const usage = {
              promptTokens: Number(data.prompt_tokens ?? 0),
              completionTokens: Number(data.completion_tokens ?? 0),
              cachedTokens: Number(data.cached_tokens ?? 0),
              costUsd: data.cost_usd == null ? null : Number(data.cost_usd),
              usageSource: (data.usage_source === "estimated" ? "estimated" : "api") as
                | "api"
                | "estimated",
              latencyMs: data.latency_ms == null ? null : Number(data.latency_ms),
              ...(rawBreakdown
                ? {
                    breakdown: {
                      system: Number(rawBreakdown.system ?? 0),
                      memory: Number(rawBreakdown.memory ?? 0),
                      skills: Number(rawBreakdown.skills ?? 0),
                      tools: Number(rawBreakdown.tools ?? 0),
                      mcpTools: Number(rawBreakdown.mcp_tools ?? 0),
                      history: Number(rawBreakdown.history ?? 0),
                      message: Number(rawBreakdown.message ?? 0),
                    },
                  }
                : {}),
            };
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({ ...v, usage }));
              }),
            );
            break;
          }
          case "done":
            dropStream(sessionId, false);
            break;
          case "error":
            // Only surface the banner if this is the chat on screen; a
            // background failure still tears its own stream down quietly.
            if (sessionId === activeIdRef.current) {
              setError(String(data.message ?? "Unknown error"));
            }
            dropStream(sessionId, false);
            break;
        }
      } catch {
        /* ignore malformed */
      }
    },
    [updateLiveFile, dropStream],
  );

  // ── Public API ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    (content: string, model?: string, attachments?: AttachmentInfo[], html?: string, thinkingEnabled?: boolean, effort?: string) => {
      if (!content.trim() && (!attachments || attachments.length === 0)) return;
      // Guard per-chat: the active chat can't double-send, but a different chat
      // streaming in the background never blocks this one.
      if (streamsRef.current.has(activeId)) return;

      setError(null);

      const sid = activeId;
      const currentSession = sessions.find((s) => s.id === sid);
      if (!currentSession) return;

      const htmlBody = html ? html.replace(/<[^>]+>/g, "").trim() : "";
      const richHtml = html && htmlBody !== "" ? html : undefined;
      const userVariant: UserVariant = {
        id: newId(),
        content,
        displayHtml: richHtml,
        plainText: richHtml ? undefined : true,
        attachments,
        createdAt: Date.now(),
      };
      const userNode: UserNode = {
        id: newId(),
        role: "user",
        variants: [userVariant],
        activeVariantIdx: 0,
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

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const updated = appendPair(s, userNode, assistantNode);
          const prevMsgs = currentBranch(s);
          const branchMsgs = currentBranch(updated);
          const wasAutoDerived = isDefaultTitle(s.title) || s.title === deriveTitle(prevMsgs);
          return {
            ...updated,
            title: wasAutoDerived ? deriveTitle(branchMsgs) : s.title,
          };
        }),
      );

      const history: WireMessage[] = [];
      if (isGhostChat(currentSession.title)) {
        history.push(buildGhostSystemMessage());
      }

      if (currentSession.root.length > 0) {
        history.push(...expandToWire(currentBranch(currentSession)));
      }
      history.push({ role: "user", content });

      const handler = makeEventHandler(sid, assistantNodeId, variantId);
      const sse = sseConnect(
        `${API_BASE}/chat`,
        {
          messages: history,
          model: model ?? undefined,
          attachments: attachments ?? undefined,
          chat_dir_slug: currentSession.dirSlug,
          chat_id: sid,
          mcp_enabled_servers: currentSession.mcpEnabledServers ?? [],
          project_id: currentSession.projectId ?? undefined,
          agent_id: currentSession.agentId ?? undefined,
          // Fall back to the sticky mirror when a caller omits these (e.g. the
          // project-chat first-message path), so the model's thinking/effort
          // always matches the composer toggles.
          thinking_enabled: thinkingEnabled ?? getThinkingDefault(),
          effort: effort ?? getEffortDefault() ?? undefined,
          web_search_enabled: currentSession.webSearchEnabled ?? getWebSearchDefault().enabled,
          web_search_mode: currentSession.webSearchMode ?? getWebSearchDefault().mode,
          research_enabled: currentSession.researchEnabled ?? getResearchDefault(),
        },
        handler,
        (err: Error) => {
          if (sid === activeIdRef.current) setError(err.message);
          dropStream(sid, false);
        },
      );
      beginStream(sid, sse, assistantNodeId, variantId);
    },
    [activeId, sessions, makeEventHandler, beginStream, dropStream],
  );

  // Fire a queued project-chat first message once its session is active and
  // present in state. Guarded + cleared immediately so it sends exactly once.
  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending || activeId !== pending.sessionId) return;
    if (!sessions.some((s) => s.id === pending.sessionId)) return;
    pendingSendRef.current = null;
    sendMessage(pending.content, pending.model, pending.attachments, pending.html);
  }, [activeId, sessions, sendMessage]);

  const retry = useCallback(() => {
    if (streamsRef.current.has(activeId) || !activeSession) return;

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

    setError(null);

    const sid = activeId;
    const { session: updated, variantId } = addVariant(activeSession, last.nodeId);

    setSessions((prev) => prev.map((s) => (s.id === sid ? updated : s)));

    const model = undefined; // retry uses same model as before
    const history: WireMessage[] = [];
    const currentSess = sessions.find((s) => s.id === sid);
    if (currentSess && currentSess.root.length > 0) {
      const branchMsgs = currentBranch(currentSess);
      const idx = branchMsgs.findIndex((m) => m.id === last.nodeId);
      const prior = idx >= 0 ? branchMsgs.slice(0, idx) : branchMsgs;
      history.push(...expandToWire(prior));
    }
    history.push({ role: "user", content: userContent });

    const handler = makeEventHandler(sid, last.nodeId, variantId);
    const sse = sseConnect(
      `${API_BASE}/chat`,
      {
        messages: history,
        model: model ?? undefined,
        attachments: userAttachments ?? undefined,
        chat_dir_slug: activeSession.dirSlug,
        chat_id: sid,
        mcp_enabled_servers: activeSession.mcpEnabledServers ?? [],
        project_id: activeSession.projectId ?? undefined,
        agent_id: activeSession.agentId ?? undefined,
        thinking_enabled: getThinkingDefault(),
        effort: getEffortDefault() ?? undefined,
        web_search_enabled: activeSession.webSearchEnabled ?? getWebSearchDefault().enabled,
        web_search_mode: activeSession.webSearchMode ?? getWebSearchDefault().mode,
        research_enabled: activeSession.researchEnabled ?? getResearchDefault(),
      },
      handler,
      (err: Error) => {
        if (sid === activeIdRef.current) setError(err.message);
        dropStream(sid, false);
      },
    );
    beginStream(sid, sse, last.nodeId, variantId);
  }, [activeSession, activeId, sessions, makeEventHandler, beginStream, dropStream]);

  const editMessage = useCallback(
    (userNodeId: string, content: string, displayHtml?: string) => {
      if (streamsRef.current.has(activeId) || !activeSession) return;
      if (!content.trim()) return;

      const added = addUserVariant(activeSession, userNodeId, content, displayHtml);
      if (!added) return;

      // Build new assistant subtree for this fresh user variant.
      const assistantNodeId = newId();
      const variantId = newId();
      const assistantVariant: AssistantVariant = {
        id: variantId,
        content: "",
        createdAt: Date.now(),
        toolCalls: [],
        children: [],
      };
      const assistantNode: AssistantNode = {
        id: assistantNodeId,
        role: "assistant",
        variants: [assistantVariant],
        activeVariantIdx: 0,
      };

      const sid = activeId;
      const withChild = setUserVariantChild(
        added.session,
        userNodeId,
        added.userVariantId,
        assistantNode,
      );

      setError(null);

      setSessions((prev) => prev.map((s) => (s.id === sid ? withChild : s)));

      // Build history: walk the active branch of `withChild` up to (but not
      // including) the edited user node, then append the new user content.
      const history: WireMessage[] = [];
      const branch = currentBranch(withChild);
      const idx = branch.findIndex((m) => m.id === userNodeId);
      const prior = idx >= 0 ? branch.slice(0, idx) : branch;
      history.push(...expandToWire(prior));
      history.push({ role: "user", content });

      // Attachments inherit from the previous active variant — already copied
      // into the new variant by addUserVariant; we pass them through so the
      // backend receives the same file context.
      const editedNode = currentBranchNodes(withChild).find(
        (n): n is UserNode => n.role === "user" && n.id === userNodeId,
      );
      const editedVariant = editedNode?.variants[editedNode.activeVariantIdx];
      const inheritedAttachments = editedVariant?.attachments;

      const handler = makeEventHandler(sid, assistantNodeId, variantId);
      const sse = sseConnect(
        `${API_BASE}/chat`,
        {
          messages: history,
          model: undefined,
          attachments: inheritedAttachments ?? undefined,
          chat_dir_slug: activeSession.dirSlug,
          chat_id: sid,
          mcp_enabled_servers: activeSession.mcpEnabledServers ?? [],
          project_id: activeSession.projectId ?? undefined,
          agent_id: activeSession.agentId ?? undefined,
          thinking_enabled: getThinkingDefault(),
          effort: getEffortDefault() ?? undefined,
          web_search_enabled: activeSession.webSearchEnabled ?? getWebSearchDefault().enabled,
          web_search_mode: activeSession.webSearchMode ?? getWebSearchDefault().mode,
          research_enabled: activeSession.researchEnabled ?? getResearchDefault(),
        },
        handler,
        (err: Error) => {
          if (sid === activeIdRef.current) setError(err.message);
          dropStream(sid, false);
        },
      );
      beginStream(sid, sse, assistantNodeId, variantId);
    },
    [activeSession, activeId, makeEventHandler, beginStream, dropStream],
  );

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
    const sid = activeId;
    const target = streamsRef.current.get(sid);
    if (target && activeSession) {
      const { nodeId, variantId } = target;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          return mapVariant(s, nodeId, variantId, (v) => {
            const hasRunning = (v.toolCalls ?? []).some((tc) => tc.status === "running");
            const isEmpty = v.content.length === 0 && (v.steps?.length ?? 0) === 0;
            if (!hasRunning && isEmpty) {
              return { ...v, content: "[aborted]" };
            }
            if (!hasRunning) return v;
            const cancel = (tc: ToolCall): ToolCall =>
              tc.status === "running"
                ? {
                    ...tc,
                    status: "cancelled" as const,
                    ...(tc.research
                      ? { research: { ...tc.research, status: "cancelled" as const } }
                      : {}),
                  }
                : tc;
            return {
              ...v,
              toolCalls: (v.toolCalls ?? []).map(cancel),
              steps: (v.steps ?? []).map((st) =>
                st.type === "tool" ? { type: "tool" as const, call: cancel(st.call) } : st,
              ),
            };
          });
        }),
      );
    }
    dropStream(sid, true);
  }, [activeId, activeSession, dropStream]);

  const newChat = useCallback((projectIdArg?: string) => {
    // Ignore anything that isn't a real project id — e.g. a MouseEvent forwarded
    // by `onClick={onNew}`. (makeSession guards too; this keeps the branching sane.)
    const projectId = typeof projectIdArg === "string" && projectIdArg ? projectIdArg : undefined;
    // For standalone chats, reuse an existing empty standalone chat rather than
    // piling up blanks. Project chats always start fresh and bound to the project.
    if (!projectId) {
      const existingEmpty = sessions.find(
        (s) => s.root.length === 0 && !s.projectId && isDefaultTitle(s.title),
      );
      if (existingEmpty) {
        if (existingEmpty.id === activeId) {
          // Already on it — just clear the artifact panel and any error. An
          // empty chat is never streaming, so there's nothing to interrupt.
          setLiveFiles([]);
          setError(null);
          return;
        }
        // Switch to it
        switchChat(existingEmpty.id);
        return;
      }
    }
    // Note: any chat already streaming keeps running in the background.
    const session = makeSession(projectId);
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setLiveFiles([]);
    setError(null);
    // Reserve the row on the server so subsequent PUTs find it. Snapshot the
    // freshly-created tree so the autosave effect doesn't redundantly PUT.
    void createChatRemote(session).then(() => {
      lastSavedRef.current.set(session.id, snapshot(session));
    });
  }, [activeId, sessions]);

  /** Create a fresh chat in a project and immediately send its first message.
   * sendMessage reads activeId/sessions from its closure, so we can't call it
   * synchronously after creation — queue the message and fire it from an effect
   * once the new session has committed to state and become active. */
  const startProjectChat = useCallback(
    (
      projectId: string,
      text: string,
      model?: string,
      attachments?: AttachmentInfo[],
      html?: string,
      dirSlug?: string,
      seed?: SessionSeed,
    ) => {
      // Reuse the slug the composer already uploaded into, so the first
      // message's attachments sit inside this chat's sandbox. Seed the
      // composer toggles (web-search/research/MCP) chosen before the chat
      // existed so the first turn honours them.
      const session = makeSession(projectId, dirSlug, seed);
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      setLiveFiles([]);
      setError(null);
      void createChatRemote(session).then(() => {
        lastSavedRef.current.set(session.id, snapshot(session));
      });
      pendingSendRef.current = { sessionId: session.id, content: text, model, attachments, html };
    },
    [],
  );

  const switchChat = useCallback(
    (id: string) => {
      if (id === activeId) return;
      // Leave any in-flight stream (this chat's or another's) running.
      setActiveId(id);
      setLiveFiles([]);
      setError(null);
      // Lazy-hydrate the tree if this chat came from the list endpoint
      // (which only returns summaries).
      const current = sessions.find((s) => s.id === id);
      if (current && current.root.length === 0) {
        void fetchChatFull(id).then((full) => {
          if (!full) return;
          // Re-check emptiness at resolve time: if the user already sent a
          // message into this chat while the fetch was in flight, replacing
          // the session with the (older) server copy would wipe that message
          // and orphan its live stream.
          setSessions((prev) =>
            prev.map((s) =>
              s.id === id && s.root.length === 0 ? { ...full, pinned: s.pinned } : s,
            ),
          );
          lastSavedRef.current.set(id, snapshot(full));
        });
      }
    },
    [activeId, sessions],
  );

  const deleteChat = useCallback(
    (id: string) => {
      // Kill the deleted chat's stream wherever it runs (active or background).
      dropStream(id, true);
      void deleteChatRemote(id);
      lastSavedRef.current.delete(id);
      const pendingTimer = saveTimersRef.current.get(id);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        saveTimersRef.current.delete(id);
      }
      // Decide the replacement chat OUTSIDE the state updater: updaters must
      // stay pure (StrictMode double-invokes them), so creating a session or
      // POSTing to the backend inside one runs twice and leaks an orphaned
      // chat row. The filter itself stays functional so concurrent background
      // stream updates to other sessions aren't clobbered.
      const remaining = sessions.filter((s) => s.id !== id);
      const replacement = id === activeId && remaining.length === 0 ? makeSession() : null;

      setSessions((prev) => {
        const kept = prev.filter((s) => s.id !== id);
        return replacement ? [replacement, ...kept] : kept;
      });
      if (id === activeId) {
        setActiveId(replacement ? replacement.id : remaining[0]!.id);
        setLiveFiles([]);
        setError(null);
      }
      if (replacement) {
        void createChatRemote(replacement).then(() => {
          lastSavedRef.current.set(replacement.id, snapshot(replacement));
        });
      }
    },
    [activeId, sessions, dropStream],
  );

  const renameChat = useCallback(
    (id: string, title: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    },
    [],
  );

  const toggleMcpServer = useCallback((serverId: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeId) return s;
        const current = new Set(s.mcpEnabledServers ?? []);
        if (current.has(serverId)) current.delete(serverId);
        else current.add(serverId);
        return { ...s, mcpEnabledServers: [...current] };
      }),
    );
  }, [activeId]);

  const setWebSearch = useCallback(
    (enabled: boolean, mode?: string) => {
      const nextMode = mode ?? activeSession?.webSearchMode ?? getWebSearchDefault().mode;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId ? { ...s, webSearchEnabled: enabled, webSearchMode: nextMode } : s,
        ),
      );
      // Update the sticky default so other chats and new chats inherit the
      // choice immediately; App persists it to settings via onWebSearchChange.
      setWsDefault({ enabled, mode: nextMode });
    },
    [activeId, activeSession],
  );

  const setResearch = useCallback(
    (enabled: boolean) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, researchEnabled: enabled } : s)),
      );
      // Sticky default — new/other chats inherit; App persists to settings.
      setRDefault(enabled);
    },
    [activeId],
  );

  const setAgent = useCallback(
    (agentId: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, agentId } : s)),
      );
    },
    [activeId],
  );

  const pinChat = useCallback((id: string) => {
    setSessions((prev) => {
      const pinnedIds = loadPinnedIds();
      if (pinnedIds.has(id)) {
        pinnedIds.delete(id);
      } else {
        pinnedIds.add(id);
      }
      savePinnedIds(pinnedIds);
      return prev.map((s) => (s.id === id ? { ...s, pinned: pinnedIds.has(id) } : s));
    });
  }, []);

  const startGhostChat = useCallback(() => {
    const session = createGhostChatSession();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setLiveFiles([]);
    setError(null);
    void createChatRemote(session).then(() => {
      lastSavedRef.current.set(session.id, snapshot(session));
    });
  }, [sessions]);

  return {
    sessions,
    activeId,
    activeDirSlug: activeSession?.dirSlug ?? null,
    activeMcpEnabled: activeSession?.mcpEnabledServers ?? [],
    activeWebSearchEnabled: activeSession?.webSearchEnabled ?? wsDefault.enabled,
    activeWebSearchMode: activeSession?.webSearchMode ?? wsDefault.mode,
    activeResearchEnabled: activeSession?.researchEnabled ?? rDefault,
    activeAgentId: activeSession?.agentId ?? "default",
    messages,
    branchNodes,
    liveFiles,
    isStreaming,
    streamingIds,
    error,
    newChat,
    startProjectChat,
    switchChat,
    deleteChat,
    renameChat,
    pinChat,
    sendMessage,
    retry,
    editMessage,
    switchVariant,
    abort,
    startGhostChat,
    toggleMcpServer,
    setWebSearch,
    setWebSearchDefault,
    setResearch,
    setResearchDefault,
    setAgent,
    setThinkingDefault,
    setEffortDefault,
  };
}
