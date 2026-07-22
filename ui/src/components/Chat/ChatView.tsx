/** Chat column — header + scrolled message list + composer. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, List } from "@phosphor-icons/react";
import { IconButton } from "@astryxdesign/core/IconButton";
import type { AgentChatState } from "../../hooks/useChats";
import { ChatInput } from "./ChatInput";
import { ChatMessageList } from "@astryxdesign/core/Chat";
import { MessageBubble } from "./MessageBubble";
import { UserQuestionCard } from "../ToolCalls/UserQuestionCard";
import type { ChatMessage, AttachmentInfo, ChatNode } from "../../types/chat";
import type { UserQuestionData } from "../../types/tool-call";
import type { Agent } from "../../types/agent";
import { API_BASE } from "../../utils/apiBase";
import { pickGreeting } from "../../utils/greetings";

/** Derive the pending ask_user prompt from the last assistant turn, if any.
 *
 * Reads the questions straight off the ask_user tool call's input so it works
 * even if the separate user_question SSE event was missed. Returns null while
 * streaming or once the user has replied (a newer message exists). */
function pendingQuestion(
  messages: ChatMessage[],
  branchNodes: ChatNode[],
  isStreaming: boolean,
): { callId: string; data: UserQuestionData } | null {
  if (isStreaming) return null;
  const lastNode = branchNodes[branchNodes.length - 1];
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastNode?.role !== "assistant") return null;

  const askCall = [...(lastMsg.toolCalls ?? [])].reverse().find((c) => c.name === "ask_user");
  if (!askCall) return null;

  const input = askCall.input as { questions?: unknown; selection_type?: unknown };
  const raw = askCall.userQuestion?.questions ?? input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const asSel = (v: unknown): "single" | "multiple" | undefined =>
    v === "multiple" ? "multiple" : v === "single" ? "single" : undefined;

  const questions = raw
    .filter((q): q is { question: string; options: unknown; selection_type?: unknown } =>
      typeof q === "object" && q !== null &&
      typeof (q as { question?: unknown }).question === "string" &&
      Array.isArray((q as { options?: unknown }).options))
    .map((q) => ({
      question: q.question,
      options: (q.options as unknown[]).map((o) => String(o)),
      selectionType: asSel(q.selection_type),
    }));
  if (questions.length === 0) return null;

  const selectionType = asSel(input.selection_type) ?? "single";

  return { callId: askCall.id, data: { chatId: "", questions, selectionType } };
}

export interface ModelItem {
  id: string;
  name?: string | null;
  thinking?: boolean | null;
  thinking_types?: string[] | null;
  effort_levels?: string[] | null;
}

interface ChatViewProps {
  activeId: string;
  state: AgentChatState;
  chatTitle: string;
  dirSlug: string | null;
  onSend: (text: string, attachments: AttachmentInfo[]) => void;
  /** Mobile only: opens the off-canvas sidebar drawer. */
  onOpenSidebar?: () => void;
  onStop: () => void;
  onRetry: () => void;
  onEdit: (userNodeId: string, content: string, displayHtml?: string) => void;
  onSwitchVariant: (nodeId: string, idx: number) => void;
  branchNodes: ChatNode[];
  onToggleFiles: () => void;
  models: ModelItem[];
  model: string;
  onModelChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  effortLevel: string | null;
  onEffortChange: (v: string | null) => void;
  mcpEnabled: string[];
  onToggleMcpServer: (serverId: string) => void;
  webSearchEnabled: boolean;
  webSearchMode: string;
  onWebSearchChange: (enabled: boolean, mode?: string) => void;
  researchEnabled: boolean;
  onResearchChange: (enabled: boolean) => void;
  agents: Agent[];
  agentId: string;
  onAgentChange: (agentId: string) => void;
}

/** Animates `text` character-by-character. `done` derives from displayed
 * length so we don't need a separate state slot — the previous two-effect
 * implementation deadlocked on text changes because effect 2 read a stale
 * `done=true` after effect 1 reset it, and the last setState in a batch
 * wins, leaving `done` stuck true and the typewriter silent. */
function useTypewriter(text: string, speed = 45): { displayed: string; done: boolean } {
  const [displayed, setDisplayed] = useState("");

  useEffect(() => {
    setDisplayed("");
    if (!text) return;

    let cancelled = false;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      i++;
      setDisplayed(text.slice(0, i));
      if (i < text.length) {
        timer = setTimeout(tick, speed + Math.random() * 20);
      }
    };
    timer = setTimeout(tick, speed);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [text, speed]);

  return { displayed, done: displayed.length >= text.length };
}

export function ChatView({
  activeId, state, chatTitle, dirSlug, onSend, onOpenSidebar, onStop, onRetry, onEdit, onSwitchVariant, branchNodes, onToggleFiles,
  models, model, onModelChange,
  thinkingEnabled, onThinkingToggle,
  effortLevel, onEffortChange,
  mcpEnabled, onToggleMcpServer,
  webSearchEnabled, webSearchMode, onWebSearchChange,
  researchEnabled, onResearchChange,
  agents, agentId, onAgentChange,
}: ChatViewProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const [userName, setUserName] = useState<string>("");
  useEffect(() => {
    fetch(`${API_BASE}/settings`)
      .then((r) => r.json())
      .then((data) => setUserName(data.user_name ?? ""))
      .catch(() => {});
  }, []);

  const [revealed, setRevealed] = useState(false);
  const greeting = useMemo(() => pickGreeting(userName || undefined), [userName, activeId]);
  const { displayed, done: typingDone } = useTypewriter(revealed ? greeting : "");

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.messages]);

  const toolCallCount = state.messages.reduce(
    (sum: number, m: ChatMessage) => sum + (m.toolCalls?.length ?? 0),
    0,
  );

  const hasFiles = state.liveFiles.length > 0 || state.messages.some(
    (m: ChatMessage) =>
      (m.attachments?.length ?? 0) > 0 ||
      (m.role === "assistant" && m.toolCalls?.some((tc) => tc.name === "write_file")),
  );

  const isEmpty = state.messages.length === 0 && !state.isStreaming;

  const pending = useMemo(
    () => pendingQuestion(state.messages, branchNodes, state.isStreaming),
    [state.messages, branchNodes, state.isStreaming],
  );

  return (
    <div className={`chat${isEmpty ? " chat--welcome" : ""}`}>
      {!isEmpty && (
        <div className="chat-head">
          {onOpenSidebar && (
            <IconButton
              className="chat-mobile-menu-btn"
              icon={<List />}
              label={t("sidebar.expand")}
              onClick={onOpenSidebar}
              variant="ghost"
              size="sm"
            />
          )}
          <div>
            <div className="chat-head-title">{chatTitle}</div>
            <div className="chat-head-subtitle">
              {t("chat.msgs", { count: state.messages.length })}
              {toolCallCount > 0 && ` · ${t("chat.toolCalls", { count: toolCallCount })}`}
              {state.isStreaming && ` · ${t("chat.streaming")}`}
            </div>
          </div>
          {hasFiles && (
            <IconButton
              className="chat-head-btn"
              icon={<FolderOpen />}
              label={t("chat.chatFiles")}
              onClick={onToggleFiles}
              variant="ghost"
              size="sm"
            />
          )}
        </div>
      )}

      {isEmpty ? (
        <div className="chat-welcome">
          {onOpenSidebar && (
            <IconButton
              className="chat-mobile-menu-btn"
              icon={<List />}
              label={t("sidebar.expand")}
              onClick={onOpenSidebar}
              variant="ghost"
              size="sm"
            />
          )}
          <div className="chat-welcome-hgroup">
            <div className="chat-welcome-logo" onClick={() => setRevealed(true)}>
              {/* Non-draggable: grabbing the ghost used to drop it into the composer. */}
              <img src="/ghost.svg" alt="" draggable={false} onDragStart={(e) => e.preventDefault()} />
            </div>
            <div className="chat-welcome-title">
              {displayed}
              {revealed && !typingDone && <span className="chat-welcome-cursor" aria-hidden>|</span>}
            </div>
          </div>
          <div className="chat-welcome-input">
            <ChatInput
              onSend={onSend}
              onStop={onStop}
              disabled={state.isStreaming}
              isStreaming={state.isStreaming}
              models={models}
              model={model}
              onModelChange={onModelChange}
              thinkingEnabled={thinkingEnabled}
              onThinkingToggle={onThinkingToggle}
              effortLevel={effortLevel}
              onEffortChange={onEffortChange}
              placeholder={t("chat.howCanIHelp")}
              dirSlug={dirSlug}
              mcpEnabled={mcpEnabled}
              onToggleMcpServer={onToggleMcpServer}
              webSearchEnabled={webSearchEnabled}
              webSearchMode={webSearchMode}
              onWebSearchChange={onWebSearchChange}
              researchEnabled={researchEnabled}
              onResearchChange={onResearchChange}
              agents={agents}
              agentId={agentId}
              onAgentChange={onAgentChange}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
            <div className="chat-scroll-inner">
            <ChatMessageList isStreaming={state.isStreaming}>
            {state.messages.map((msg: ChatMessage, idx: number) => {
              const node = branchNodes[idx];
              const isLast = idx === branchNodes.length - 1;
              const isAssistantNode = node?.role === "assistant";
              const isUserNode = node?.role === "user";
              const isLastAssistant = isAssistantNode && isLast;
              const isLastInBranch = isLastAssistant;
              const variantCount = node
                ? (node.role === "assistant" ? node.variants.length : node.variants.length)
                : 0;
              const variantIndex = node
                ? (node.role === "assistant" ? node.activeVariantIdx + 1 : node.activeVariantIdx + 1)
                : 0;
              const nodeId = node?.id;

              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  liveFiles={state.liveFiles}
                  onRetry={isLastInBranch ? onRetry : undefined}
                  onEdit={isUserNode ? onEdit : undefined}
                  canEdit={isUserNode && !state.isStreaming}
                  isLastAssistantInBranch={isLastInBranch}
                  variantCount={variantCount}
                  variantIndex={variantIndex}
                  nodeId={nodeId}
                  onSwitchVariant={nodeId ? onSwitchVariant : undefined}
                  isGlobalStreaming={isLastInBranch ? state.isStreaming : false}
                />
              );
            })}
            </ChatMessageList>
            {state.error && (
              <div className="msg msg-assistant" style={{ color: "var(--accent)" }}>
                {t("chat.error")}: {state.error}
              </div>
            )}
            </div>
          </div>

          {pending && (
            <div className="uq-dock">
              <UserQuestionCard
                key={pending.callId}
                data={pending.data}
                onSubmit={(text) => onSend(text, [])}
              />
            </div>
          )}

          <ChatInput
            onSend={onSend}
            onStop={onStop}
            disabled={state.isStreaming}
            isStreaming={state.isStreaming}
            models={models}
            model={model}
            onModelChange={onModelChange}
            thinkingEnabled={thinkingEnabled}
            onThinkingToggle={onThinkingToggle}
            effortLevel={effortLevel}
            onEffortChange={onEffortChange}
            dirSlug={dirSlug}
            mcpEnabled={mcpEnabled}
            onToggleMcpServer={onToggleMcpServer}
            webSearchEnabled={webSearchEnabled}
            webSearchMode={webSearchMode}
            onWebSearchChange={onWebSearchChange}
            researchEnabled={researchEnabled}
            onResearchChange={onResearchChange}
            agents={agents}
            agentId={agentId}
            onAgentChange={onAgentChange}
          />
        </>
      )}
    </div>
  );
}
