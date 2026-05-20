/** Chat column — header + scrolled message list + composer. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Sparkle } from "@phosphor-icons/react";
import type { AgentChatState } from "../../hooks/useAgentChat";
import { ChatInput } from "./ChatInput";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage, AttachmentInfo, ChatNode } from "../../types/chat";
import { API_BASE } from "../../utils/apiBase";

export interface ModelItem {
  id: string;
  name?: string | null;
  thinking?: boolean | null;
}

interface ChatViewProps {
  state: AgentChatState;
  chatTitle: string;
  dirSlug: string | null;
  onSend: (text: string, attachments: AttachmentInfo[]) => void;
  onStop: () => void;
  onRetry: () => void;
  onSwitchVariant: (nodeId: string, idx: number) => void;
  branchNodes: ChatNode[];
  onToggleFiles: () => void;
  models: ModelItem[];
  model: string;
  onModelChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
}

function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  if (hour >= 18 && hour < 22) return "Добрый вечер";
  return "Доброй ночи";
}

const QUICK_CHIPS = [
  "Напиши bash-скрипт",
  "Объясни этот код",
  "Найди баг",
  "Создай файл",
];

function useTypewriter(text: string, speed = 45): { displayed: string; done: boolean } {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDisplayed("");
    setDone(false);
  }, [text]);
  useEffect(() => {
    if (done || displayed.length >= text.length) { setDone(true); return; }
    const t = setTimeout(
      () => setDisplayed(text.slice(0, displayed.length + 1)),
      speed + Math.random() * 20,
    );
    return () => clearTimeout(t);
  }, [displayed, done, text, speed]);
  return { displayed, done };
}

export function ChatView({
  state, chatTitle, dirSlug, onSend, onStop, onRetry, onSwitchVariant, branchNodes, onToggleFiles,
  models, model, onModelChange,
  thinkingEnabled, onThinkingToggle,
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

  const welcomePhrase = useMemo(() => {
    if (userName) return `${getTimeGreeting()}, ${userName}`;
    return getTimeGreeting();
  }, [userName]);
  const { displayed, done: typingDone } = useTypewriter(welcomePhrase);
  const [fillText, setFillText] = useState<string | null>(null);

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
    (m: ChatMessage) => (m.attachments?.length ?? 0) > 0,
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
          <div className="chat-welcome-logo">
            <Sparkle weight="duotone" />
          </div>
          <div className="chat-welcome-title">
            {displayed}
            {!typingDone && <span className="chat-welcome-cursor" aria-hidden>|</span>}
          </div>
          <div className="chat-welcome-chips">
            {QUICK_CHIPS.map((chip) => (
              <button key={chip} className="chat-welcome-chip" onClick={() => setFillText(chip)}>
                {chip}
              </button>
            ))}
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
              placeholder="Чем я могу помочь?"
              fillText={fillText ?? undefined}
              onFillTextConsumed={() => setFillText(null)}
              dirSlug={dirSlug}
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
              const isLastAssistant = isAssistantNode && isLast;
              const isLastInBranch = isLastAssistant;
              const variantCount = isAssistantNode ? node.variants.length : 0;
              const variantIndex = isAssistantNode ? node.activeVariantIdx + 1 : 0;
              const nodeId = isAssistantNode ? node.id : undefined;

              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  liveFiles={state.liveFiles}
                  onRetry={isLastInBranch ? onRetry : undefined}
                  isLastAssistantInBranch={isLastInBranch}
                  variantCount={variantCount}
                  variantIndex={variantIndex}
                  nodeId={nodeId}
                  onSwitchVariant={nodeId ? onSwitchVariant : undefined}
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
          />
        </>
      )}
    </div>
  );
}
