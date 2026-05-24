/** Chat column — header + scrolled message list + composer. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type { AgentChatState } from "../../hooks/useChats";
import { ChatInput } from "./ChatInput";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage, AttachmentInfo, ChatNode } from "../../types/chat";
import { API_BASE } from "../../utils/apiBase";
import { pickGreeting } from "../../utils/greetings";

export interface ModelItem {
  id: string;
  name?: string | null;
  thinking?: boolean | null;
}

interface ChatViewProps {
  activeId: string;
  state: AgentChatState;
  chatTitle: string;
  dirSlug: string | null;
  onSend: (text: string, attachments: AttachmentInfo[]) => void;
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
  mcpEnabled: string[];
  onToggleMcpServer: (serverId: string) => void;
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
  activeId, state, chatTitle, dirSlug, onSend, onStop, onRetry, onEdit, onSwitchVariant, branchNodes, onToggleFiles,
  models, model, onModelChange,
  thinkingEnabled, onThinkingToggle,
  mcpEnabled, onToggleMcpServer,
}: ChatViewProps) {
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

  return (
    <div className={`chat${isEmpty ? " chat--welcome" : ""}`}>
      {!isEmpty && (
        <div className="chat-head">
          <div>
            <div className="chat-head-title">{chatTitle}</div>
            <div className="chat-head-subtitle">
              {state.messages.length} msgs
              {toolCallCount > 0 && ` · ${toolCallCount} tool calls`}
              {state.isStreaming && " · streaming"}
            </div>
          </div>
          {hasFiles && (
            <button className="chat-head-btn" onClick={onToggleFiles} title="Файлы чата">
              <FolderOpen />
            </button>
          )}
        </div>
      )}

      {isEmpty ? (
        <div className="chat-welcome">
          <div className="chat-welcome-hgroup">
            <div className="chat-welcome-logo" onClick={() => setRevealed(true)}>
              <img src="/ghost.svg" alt="" />
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
              placeholder="Как я могу помочь?"
              dirSlug={dirSlug}
              mcpEnabled={mcpEnabled}
              onToggleMcpServer={onToggleMcpServer}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
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
            {state.error && (
              <div className="msg msg-assistant" style={{ color: "var(--accent)" }}>
                Error: {state.error}
              </div>
            )}
          </div>

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
            dirSlug={dirSlug}
            mcpEnabled={mcpEnabled}
            onToggleMcpServer={onToggleMcpServer}
          />
        </>
      )}
    </div>
  );
}
