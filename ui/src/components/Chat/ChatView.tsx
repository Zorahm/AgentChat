/** Chat column — header + scrolled message list + composer. */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { FolderOpen, Sparkle } from "@phosphor-icons/react";
import type { AgentChatState } from "../../hooks/useAgentChat";
import { ChatInput } from "./ChatInput";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage, AttachmentInfo, ChatNode } from "../../types/chat";

export interface ModelItem {
  id: string;
  name?: string | null;
  thinking?: boolean | null;
}

interface ChatViewProps {
  state: AgentChatState;
  chatTitle: string;
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

const WELCOME_PHRASES = [
  "Чем займёмся сегодня?",
  "Что будем кодить?",
  "Новый проект или багфикс?",
  "Готов к работе.",
  "Спрашивай — не стесняйся.",
  "Идеи в студию.",
  "Давай сделаем что-то крутое.",
  "Код, чай и никаких дедлайнов.",
  "Ваш персональный агент на связи.",
  "Что на повестке?",
  "Ныряем в код?",
  "Время магии.",
];

function pickPhrase(): string {
  return WELCOME_PHRASES[Math.floor(Math.random() * WELCOME_PHRASES.length)]!;
}

export function ChatView({
  state, chatTitle, onSend, onStop, onRetry, onSwitchVariant, branchNodes, onToggleFiles,
  models, model, onModelChange,
  thinkingEnabled, onThinkingToggle,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const welcomePhrase = useMemo(() => pickPhrase(), []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) shouldAutoScroll.current = entry.isIntersecting;
      },
      { root, threshold: 0, rootMargin: "0px 0px 80px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
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
            <Sparkle />
          </div>
          <div className="chat-welcome-title">{welcomePhrase}</div>
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
            />
          </div>
        </div>
      ) : (
        <>
          <div className="chat-scroll" ref={scrollRef}>
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
            <div ref={sentinelRef} aria-hidden style={{ height: 1, width: "100%" }} />
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
          />
        </>
      )}
    </div>
  );
}
