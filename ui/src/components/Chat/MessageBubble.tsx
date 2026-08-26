/** Single message bubble — user or assistant with process block, markdown, artifacts. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, ArrowClockwise, CaretLeft, CaretRight, CaretDown, CaretUp, PencilSimple, X } from "@phosphor-icons/react";
import { Brain, Spinner, CheckCircle, CaretDoubleDown, Warning, Globe, AppWindow, ArrowSquareOut } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Badge } from "@astryxdesign/core/Badge";
import { Spinner as AstryxSpinner } from "@astryxdesign/core/Spinner";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { parseMcpToolName } from "../../utils/mcpName";
import { API_BASE, withToken } from "../../utils/apiBase";
import type { ChatMessage, AttachmentInfo, MessageUsage } from "../../types/chat";
import type { ToolCall, ToolCallStatus, ProcessStep } from "../../types/tool-call";
import { ResearchCard } from "./Research/ResearchCard";
import { ImageGenCard } from "./ImageGenCard";
import { MathPlotCard } from "./MathPlotCard";
import { VerificationBadge } from "./VerificationBadge";
import { RetryNotice } from "./RetryNotice";
import { copyText } from "../../utils/copyText";
import { SourcesBox } from "./SourcesBox";
import { aggregateUrls, extractUrls } from "../../utils/research";
import { ArtifactCard } from "../Artifacts/ArtifactCard";
import { WidgetView, WidgetSkeleton } from "../Artifacts/WidgetView";
import { SupportCard } from "./SupportCard";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MathMarkdown } from "../MathMarkdown";
import { ChatMessage as ChatMsg, ChatMessageBubble, ChatMessageMetadata, ChatToolCalls } from "@astryxdesign/core/Chat";
import type { ChatToolCallItem, ChatToolCallStatus } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { presentedArtifacts } from "../../utils/presentedFiles";
import { getLang } from "../../utils/getLang";
import { basename } from "../../utils/basename";
import { toolActivity } from "../../utils/toolActivity";
import { messageDomId } from "../../hooks/useMessageFocus";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import type { LiveFile } from "../../types/artifact";
import { Question } from "@phosphor-icons/react";

interface MessageBubbleProps {
  message: ChatMessage;
  /** The chat this message belongs to — the Re-check button files its result
   *  under it, so the history is purged with the chat rather than orphaned. */
  chatId?: string;
  liveFiles?: LiveFile[];
  onRetry?: () => void;
  onEdit?: (userNodeId: string, content: string, displayHtml?: string) => void;
  canEdit?: boolean;
  isLastAssistantInBranch?: boolean;
  isGlobalStreaming?: boolean;
  variantCount?: number;
  variantIndex?: number;
  nodeId?: string;
  onSwitchVariant?: (nodeId: string, idx: number) => void;
  /** The keyboard ring (Alt+↑/↓) is on this message — see useMessageFocus. */
  focused?: boolean;
}

function MarkdownContent({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <MathMarkdown display="block" isStreaming={streaming} className="msg-markdown">
      {text}
    </MathMarkdown>
  );
}

export function MessageBubble({
  message, chatId = "", liveFiles = [], onRetry, onEdit, canEdit = false, isLastAssistantInBranch,
  isGlobalStreaming = false, variantCount = 0, variantIndex = 0, nodeId, onSwitchVariant,
  focused = false,
}: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <UserBubble
        message={message}
        onEdit={onEdit}
        canEdit={canEdit}
        variantCount={variantCount}
        variantIndex={variantIndex}
        nodeId={nodeId}
        onSwitchVariant={onSwitchVariant}
        focused={focused}
      />
    );
  }

  const steps = message.steps ?? [];
  const groups = splitStepGroups(steps);

  const iterExhausted = steps.find(
    (s): s is Extract<ProcessStep, { type: "iterations_exhausted" }> => s.type === "iterations_exhausted",
  );

  const useFallback = groups.length === 0 && message.content.length > 0;
  const fallback = useFallback ? parseArtifacts(message.content) : null;

  // File cards come from present_files tool calls (one set per message,
  // rendered after the text), not from inline text tags anymore.
  const presented = presentedArtifacts(message.toolCalls);

  const hasContent = useFallback || groups.length > 0;
  const hasVariants = variantCount > 1;

  return (
    <ChatMsg
      sender="assistant"
      id={messageDomId(message.id)}
      className={`msg msg-assistant${focused ? " msg--focused" : ""}`}
    >
      {hasVariants && (
        <VariantNav
          total={variantCount}
          current={variantIndex}
          onPrev={() => nodeId && onSwitchVariant?.(nodeId, variantIndex - 2)}
          onNext={() => nodeId && onSwitchVariant?.(nodeId, variantIndex)}
        />
      )}

      {groups.map((g, i) => {
        const procSteps = g.filter((s): s is Extract<ProcessStep, { type: "thought" | "tool" }> =>
          s.type === "thought" || s.type === "tool");
        const groupText = g
          .filter((s): s is Extract<ProcessStep, { type: "text" }> => s.type === "text")
          .map((s) => s.content)
          .join("");
        const isLast = i === groups.length - 1;
        const parsed = groupText ? parseArtifacts(groupText) : { cleanText: "", support: false };

        // Research, images, plots and widgets each draw their own card instead
        // of hiding inside the collapsed process block — a picture the user
        // never sees is worth nothing. They are emitted in CALL ORDER, so a
        // reply that draws, explains, then draws again reads in that order
        // rather than stacking both pictures at the top.
        // The badge belongs with the ANSWER, so it is rendered after this
        // group's text rather than up with the tool calls that produced it.
        const groupVerify = procSteps
          .filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool")
          .map((s) => s.call)
          .filter((c) => c.name === "math_verify" && c.verify !== undefined);
        // present_files surfaces its results as ArtifactCards below the message
        // (see `presented`), and math_verify as the badge above — so neither
        // belongs in the process block, where it would show up twice.
        const visibleProc = procSteps.filter(
          (s) =>
            !(
              s.type === "tool" &&
              (s.call.name === "present_files" || s.call.name === "math_verify")
            ),
        );
        const segments = splitCardSegments(visibleProc);
        const lastProcIndex = segments.reduce(
          (last, segment, index) => (segment.kind === "proc" ? index : last),
          -1,
        );

        // Spinner while: any tool in this group is still running,
        // OR the global SSE stream is active but this group has no text yet
        // (tools just completed, model hasn't responded yet).
        // Non-last groups are always done — checkmark.
        // Card tools carry their own spinner, so they don't drive the process
        // block's streaming state — only the steps still inside one do.
        const anyGroupToolRunning = segments
          .flatMap((segment) => (segment.kind === "proc" ? segment.steps : []))
          .filter((s): s is Extract<ProcessStep, { type: "tool" }> => s.type === "tool")
          .some((s) => s.call.status === "running");
        const blockStreaming = isLast && (anyGroupToolRunning || (isGlobalStreaming && !groupText));

        return (
          <div className="msg-group" key={i}>
            {segments.map((segment, index) =>
              segment.kind === "proc" ? (
                <ProcessBlock
                  key={`proc-${index}`}
                  steps={segment.steps}
                  // Only the last process block can still be running; an earlier
                  // one is finished by definition, since a card came after it.
                  isStreaming={blockStreaming && index === lastProcIndex}
                  liveFiles={liveFiles}
                  webSearchMode={message.webSearchMode}
                />
              ) : (
                <CardForCall key={`card-${segment.call.id}`} call={segment.call} />
              ),
            )}
            {parsed.cleanText.trim() && (
              <ChatMessageBubble variant="ghost">
                <MarkdownContent text={parsed.cleanText} streaming={blockStreaming} />
              </ChatMessageBubble>
            )}
            {groupVerify.map((c) => (
              <VerificationBadge key={`verify-${c.id}`} call={c} chatId={chatId} />
            ))}
            {parsed.support && <SupportCard />}
          </div>
        );
      })}

      {fallback && fallback.cleanText.trim() && (
        <ChatMessageBubble variant="ghost">
          <MarkdownContent text={fallback.cleanText} />
        </ChatMessageBubble>
      )}
      {fallback && fallback.support && <SupportCard />}

      {presented.map((a, i) => (
        <ArtifactCard key={`art-${i}`} artifact={a} />
      ))}

      {/* Nothing streamed yet — reassure the user the model is still alive.
          A frozen turn has its own, more specific card instead. */}
      {isGlobalStreaming && !hasContent && !message.retry && <ThinkingIndicator />}

      {message.retry && <RetryNotice retry={message.retry} />}

      {message.webSearchMode === "native" && <NativeWebSearchChip />}

      {iterExhausted && <IterationsExhaustedCard count={iterExhausted.count} />}

      {!isGlobalStreaming && message.usage && <UsageLine usage={message.usage} />}

      {!isGlobalStreaming && <MsgActions content={parseArtifacts(message.content).cleanText} onRetry={isLastAssistantInBranch ? onRetry : undefined} />}
    </ChatMsg>
  );
}

/* ── Thinking indicator (waiting for the first token) ──────────────── */

/** Shown while an assistant turn is streaming but has produced no text, tool
 * call, or thought yet — so the user sees the model is alive even when the
 * network or provider is slow. After a delay it hints at a slow connection. */
function ThinkingIndicator() {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 9000);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="reply-wait" role="status" aria-live="polite">
      <span className="reply-wait-dots" aria-hidden>
        <span /><span /><span />
      </span>
      <span className="reply-wait-text">
        {slow ? t("chat.slowConnection") : t("chat.thinking")}
      </span>
    </div>
  );
}

/* ── Per-message usage/cost line ───────────────────────────────────── */

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function buildUsageTooltip(usage: MessageUsage, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const lines: string[] = [];
  if (usage.usageSource === "estimated") lines.push(t("chat.usage.estimatedTitle"));
  const b = usage.breakdown;
  if (b) {
    // Skip categories that don't apply to this turn (e.g. no MCP servers
    // enabled, not a project chat) instead of padding the tooltip with zeros.
    const rows: [keyof typeof b, string][] = [
      ["system", "chat.usage.breakdown.system"],
      ["memory", "chat.usage.breakdown.memory"],
      ["agentMemory", "chat.usage.breakdown.agentMemory"],
      ["skills", "chat.usage.breakdown.skills"],
      ["tools", "chat.usage.breakdown.tools"],
      ["mcpTools", "chat.usage.breakdown.mcpTools"],
      ["history", "chat.usage.breakdown.history"],
      ["message", "chat.usage.breakdown.message"],
    ];
    for (const [key, i18nKey] of rows) {
      if (b[key] > 0) lines.push(t(i18nKey, { count: b[key] }));
    }
  } else {
    lines.push(t("chat.usage.title", { prompt: usage.promptTokens, completion: usage.completionTokens }));
  }
  return lines.join("\n");
}

function formatSpeed(tokensPerSecond: number): string {
  return tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

function UsageLine({ usage }: { usage: MessageUsage }) {
  const { t } = useTranslation();
  const estimated = usage.usageSource === "estimated";
  const costLabel = usage.costUsd == null ? t("chat.usage.notAvailable") : `$${usage.costUsd.toFixed(3)}`;
  const speed =
    usage.latencyMs && usage.latencyMs > 0 && usage.completionTokens > 0
      ? usage.completionTokens / (usage.latencyMs / 1000)
      : null;
  return (
    <ChatMessageMetadata
      footer={
        <span title={buildUsageTooltip(usage, t)}>
          {estimated && "≈ "}
          {formatTokenCount(usage.promptTokens)} → {formatTokenCount(usage.completionTokens)} {t("chat.usage.tokensAbbrev")} · {costLabel}
          {speed != null && <> · {formatSpeed(speed)} {t("chat.usage.speedAbbrev")}</>}
          {usage.latencyMs != null && <> · {formatDuration(usage.latencyMs, t)}</>}
        </span>
      }
    />
  );
}

/* ── User bubble with inline editor + variant navigation ──────────── */

interface UserBubbleProps {
  message: ChatMessage;
  onEdit?: (userNodeId: string, content: string, displayHtml?: string) => void;
  canEdit: boolean;
  variantCount: number;
  variantIndex: number;
  nodeId?: string;
  onSwitchVariant?: (nodeId: string, idx: number) => void;
  focused: boolean;
}

function UserBubble({
  message, onEdit, canEdit, variantCount, variantIndex, nodeId, onSwitchVariant, focused,
}: UserBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const MAX_LINES = 8;
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  // Pre-displayHtml builds stored tiptap HTML directly in `content`; detect
  // those by shape. Messages flagged plainText are known-plain — never treat
  // their content as HTML, even if the user pasted something tag-shaped.
  const legacyHtml = !message.displayHtml && !message.plainText &&
    (message.content.startsWith("<p>") || message.content.startsWith("<div>"))
    ? message.content
    : null;
  const renderHtml = message.displayHtml ?? legacyHtml;
  const copyText = legacyHtml
    ? message.content.replace(/<[^>]+>/g, "").trim()
    : message.content;
  const textContent = renderHtml
    ? renderHtml.replace(/<[^>]+>/g, "").trim()
    : message.content;
  const lineCount = textContent.split("\n").length;
  const isLong = lineCount > MAX_LINES;
  const hasVariants = variantCount > 1;

  if (editing && onEdit && nodeId) {
    return (
      <div id={messageDomId(message.id)} className="msg msg-user msg-user--editing">
        <InlineEditor
          initialText={textContent}
          onCancel={() => setEditing(false)}
          onSave={(newText) => {
            setEditing(false);
            onEdit(nodeId, newText, undefined);
          }}
        />
      </div>
    );
  }

  return (
    <ChatMsg
      sender="user"
      id={messageDomId(message.id)}
      className={`msg msg-user${focused ? " msg--focused" : ""}`}
    >
      {hasAttachments && (() => {
        const images = message.attachments!.filter((a) => a.mime_type.startsWith("image/"));
        const files = message.attachments!.filter((a) => !a.mime_type.startsWith("image/"));
        return (
          <>
            {images.length > 0 && (
              <div className="msg-img-row">
                {images.map((a) => {
                  const src = a.data_url
                    ?? (a.path ? withToken(`${API_BASE}/files/serve?path=${encodeURIComponent(a.path)}`) : null);
                  return src ? (
                    <div key={a.name} className="msg-img-thumb">
                      <img src={src} alt={a.name} />
                    </div>
                  ) : null;
                })}
              </div>
            )}
            {files.length > 0 && (
              <div className="msg-file-chips">
                {files.map((a) => {
                  const ext = a.name.includes(".")
                    ? a.name.split(".").pop()!.toUpperCase().slice(0, 5)
                    : "FILE";
                  return (
                    <div key={a.name} className="msg-file-chip">
                      <div className="msg-file-chip-info">
                        <div className="msg-file-chip-name">{a.name}</div>
                        <div className="msg-file-chip-meta">{fmtSize(a.size)}</div>
                      </div>
                      <span className="msg-file-chip-badge">{ext}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}
      <ChatMessageBubble variant="filled">
        {renderHtml ? (
          <div
            className={`msg-user-bubble${isLong && !expanded ? " msg-user-bubble--collapsed" : ""}`}
            dangerouslySetInnerHTML={{ __html: renderHtml }}
          />
        ) : (
          <div className="msg-user-bubble msg-user-bubble--plain">
            {message.content}
          </div>
        )}
      </ChatMessageBubble>
      {isLong && (
        <IconButton
          icon={expanded ? <CaretUp size={12} /> : <CaretDoubleDown size={12} />}
          label="expand"
          onClick={() => setExpanded((v) => !v)}
          variant="ghost"
          size="sm"
        />
      )}
      <div className="msg-user-foot">
        <Timestamp value={message.timestamp / 1000} format="date_time" />
        <MsgActions
          content={copyText}
          onEdit={onEdit && nodeId ? () => setEditing(true) : undefined}
          canEdit={canEdit}
          compact
        />
      </div>
      {hasVariants && (
        <VariantNav
          total={variantCount}
          current={variantIndex}
          onPrev={() => nodeId && onSwitchVariant?.(nodeId, variantIndex - 2)}
          onNext={() => nodeId && onSwitchVariant?.(nodeId, variantIndex)}
        />
      )}
    </ChatMsg>
  );
}

/* ── Inline editor for user messages ──────────────────────────────── */

interface InlineEditorProps {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}

function InlineEditor({ initialText, onSave, onCancel }: InlineEditorProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // Auto-grow to content
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, []);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (canSave) onSave(text.trim());
    }
  };

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialText.trim();

  return (
    <div className="msg-edit">
      <textarea
        ref={taRef}
        className="msg-edit-textarea"
        value={text}
        onChange={handleInput}
        onKeyDown={handleKey}
        placeholder={t("chat.editMessagePlaceholder")}
      />
      <div className="msg-edit-actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<X />}
          label={t("chat.cancel")}
          onClick={onCancel}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<Check />}
          label={t("chat.send")}
          onClick={() => canSave && onSave(trimmed)}
          isDisabled={!canSave}
        />
      </div>
    </div>
  );
}

/* ── Variant navigation ────────────────────── */

function VariantNav({ total, current, onPrev, onNext }: {
  total: number;
  current: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="msg-variant-nav">
      <IconButton
        icon={<CaretLeft />}
        isDisabled={current <= 1}
        onClick={onPrev}
        label={t("chat.previousVariant")}
        variant="ghost"
        size="sm"
      />
      <span className="msg-variant-label">{current}/{total}</span>
      <IconButton
        icon={<CaretRight />}
        isDisabled={current >= total}
        onClick={onNext}
        label={t("chat.nextVariant")}
        variant="ghost"
        size="sm"
      />
    </div>
  );
}

/* ── Message action bar (copy + retry) ──────── */

function MsgActions({ content, onRetry, onEdit, canEdit, compact }: {
  content: string;
  onRetry?: () => void;
  onEdit?: () => void;
  canEdit?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await copyText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className={`msg-actions${compact ? " msg-actions--compact" : ""}`}>
      <IconButton
        icon={copied ? <Check size={18} /> : <Copy size={18} />}
        label={copied ? t("chat.copied") : t("chat.copy")}
        onClick={handleCopy}
        variant="ghost"
        size="sm"
      />
      {onEdit && (
        <IconButton
          icon={<PencilSimple size={18} />}
          label={canEdit ? t("chat.edit") : t("chat.waitForResponse")}
          onClick={() => canEdit && onEdit()}
          isDisabled={!canEdit}
          variant="ghost"
          size="sm"
        />
      )}
      {onRetry && (
        <IconButton
          icon={<ArrowClockwise size={18} />}
          label={t("chat.retry")}
          onClick={() => onRetry()}
          variant="ghost"
          size="sm"
        />
      )}
    </div>
  );
}

/* ── Process block ─────────────────────────── */

/** Tools that draw their own card instead of sitting inside the process block.
 *  `present_files` is absent on purpose — it surfaces at the end of the message
 *  as ArtifactCards, and `math_verify` renders as a badge after the text. */
const CARD_TOOLS = new Set(["research", "image_generate", "math_plot", "show_widget"]);

type Segment =
  | { kind: "proc"; steps: ProcessStep[] }
  | { kind: "card"; call: ToolCall };

/** Cut a group's steps into an ordered run of process blocks and cards.
 *
 * The cards used to be bucketed by type and emitted together ahead of the text,
 * so a reply that drew one plot, explained it, then drew another showed both
 * plots stacked at the top. Walking the steps in order puts each card back where
 * the model actually produced it. */
function splitCardSegments(steps: ProcessStep[]): Segment[] {
  const segments: Segment[] = [];
  let pending: ProcessStep[] = [];
  for (const step of steps) {
    if (step.type === "tool" && CARD_TOOLS.has(step.call.name)) {
      if (pending.length > 0) {
        segments.push({ kind: "proc", steps: pending });
        pending = [];
      }
      segments.push({ kind: "card", call: step.call });
    } else {
      pending.push(step);
    }
  }
  if (pending.length > 0) segments.push({ kind: "proc", steps: pending });
  return segments;
}

/** The card a card-tool draws. One place that knows which tool means which. */
function CardForCall({ call }: { call: ToolCall }) {
  if (call.name === "research") return <ResearchCard call={call} />;
  if (call.name === "image_generate") return <ImageGenCard call={call} />;
  if (call.name === "math_plot") return <MathPlotCard call={call} />;

  const title = typeof call.input?.title === "string" ? call.input.title : undefined;
  if (call.status === "success" && typeof call.input?.html === "string") {
    return <WidgetPreviewBlock html={String(call.input.html ?? "")} title={title} />;
  }
  if (call.status === "running") return <WidgetSkeleton title={title} />;
  return null;
}

function splitStepGroups(steps: ProcessStep[]): ProcessStep[][] {
  const groups: ProcessStep[][] = [];
  let current: ProcessStep[] = [];
  for (const s of steps) {
    if (s.type === "break") {
      if (current.length > 0) { groups.push(current); current = []; }
    } else {
      current.push(s);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildProcessTitle(steps: ProcessStep[], streaming: boolean, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const tools = steps.filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool");
  const hasThoughts = steps.some((s) => s.type === "thought");

  const TOOL_VERBS_PRESENT: Record<string, string> = {
    bash_tool: t("chat.tools.bash.present"),
    read_file: t("chat.tools.readFile.present"),
    list_dir: t("chat.tools.listDir.present"),
    read_photo: t("chat.tools.readPhoto.present"),
    write_file: t("chat.tools.writeFile.present"),
    edit_file: t("chat.tools.editFile.present"),
    read_skill: t("chat.tools.readSkill.present"),
    web_search: t("chat.tools.webSearch.present"),
    show_widget: t("chat.tools.showWidget.present"),
  };
  const TOOL_VERBS_PAST: Record<string, string> = {
    bash_tool: t("chat.tools.bash.past"),
    read_file: t("chat.tools.readFile.past"),
    list_dir: t("chat.tools.listDir.past"),
    read_photo: t("chat.tools.readPhoto.past"),
    write_file: t("chat.tools.writeFile.past"),
    edit_file: t("chat.tools.editFile.past"),
    read_skill: t("chat.tools.readSkill.past"),
    web_search: t("chat.tools.webSearch.past"),
    show_widget: t("chat.tools.showWidget.past"),
  };

  if (tools.length === 0) {
    return streaming ? t("chat.process.thinking") : t("chat.process.thought");
  }

  const verbMap = streaming ? TOOL_VERBS_PRESENT : TOOL_VERBS_PAST;
  const seen = new Set<string>();
  const verbs: string[] = [];
  for (const tool of tools) {
    const activity = toolActivity(tool.call);
    if (activity) {
      verbs.push(activity);
      continue;
    }
    if (seen.has(tool.call.name)) continue;
    seen.add(tool.call.name);
    const mcp = parseMcpToolName(tool.call.name);
    if (mcp) {
      verbs.push(t(streaming ? "chat.tools.mcp.present" : "chat.tools.mcp.past", { server: mcp.server }));
    } else {
      verbs.push(verbMap[tool.call.name] ?? tool.call.name);
    }
  }

  let phrase = verbs.join(", ");
  if (hasThoughts) {
    phrase = (streaming ? t("chat.process.thinkingWith") : t("chat.process.thoughtWith")) + phrase;
  } else {
    phrase = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }
  return phrase + (streaming ? "…" : "");
}

function ProcessBlock({
  steps, isStreaming, liveFiles, webSearchMode,
}: {
  steps: ProcessStep[];
  isStreaming: boolean;
  liveFiles: LiveFile[];
  webSearchMode?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Auto-open while streaming so the live preview is visible
  useEffect(() => { if (isStreaming) setOpen(true); }, [isStreaming]);

  const toolCalls = steps.filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool");
  const totalMs = toolCalls.reduce((sum, s) => sum + (s.call.durationMs ?? 0), 0);
  const title = buildProcessTitle(steps, isStreaming, t);

  return (
    <div className="thinking">
      <div className="thinking-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}>
        <span className="thinking-ic">
          {isStreaming ? <AstryxSpinner size="sm" /> : <CheckCircle />}
        </span>
        <span className="thinking-lbl">{title}</span>
        {toolCalls.length > 0 && !isStreaming && totalMs > 0 && (
          <Badge variant="neutral" label={`${(totalMs / 1000).toFixed(1)}${t("chat.process.seconds")}`} />
        )}
        <span className="thinking-chev">{open ? <CaretDown /> : <CaretRight />}</span>
      </div>

      {/* thinking-body (and any live file preview inside it) only mounts while
          this block is expanded — collapsing it tears the live preview down too. */}
      {open && (
        <>
        <div className="thinking-body">
          {renderProcessSteps(steps, isStreaming, liveFiles, webSearchMode, t)}
        </div>
        {!isStreaming && (
          <div className="thinking-done">
            <span className="thinking-done-ic"><CheckCircle weight="fill" /></span>
            <span className="thinking-done-lbl">{t("chat.process.done")}</span>
          </div>
        )}
        </>
      )}
    </div>
  );
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** Renders a mixed thought/tool step sequence: thoughts and the interactive
 * ask_user/show_widget rows keep their own bespoke UI; every other ("simple")
 * tool call — bash/read/write/edit/skill/search/mcp/... — is batched into
 * consecutive runs and rendered as a single Astryx `ChatToolCalls` group,
 * mirroring how the model actually issued them. */
function renderProcessSteps(
  steps: ProcessStep[],
  isStreaming: boolean,
  liveFiles: LiveFile[],
  webSearchMode: string | undefined,
  t: TFunc,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer: ToolCall[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const calls = buffer;
    const items: ChatToolCallItem[] = calls.map((c) =>
      buildToolCallItem(c, t, { liveFile: liveFiles.find((lf) => lf.id === c.id), webSearchMode }),
    );
    const hasRunning = calls.some((c) => c.status === "running");
    nodes.push(
      <ChatToolCalls key={`tcg-${calls[0]!.id}`} calls={items} defaultIsExpanded={hasRunning || undefined} />,
    );
    // A running call's preview is rendered NEXT TO the group, not inside the
    // row's `resultDetail`: Astryx's CallRow keeps that collapsed in its own
    // state and exposes no way to open it, so anything put there is invisible
    // unless the user clicks the row — and the click has to land before the
    // call ends, since a finished call has no live preview left to show.
    // Latest first: a batch streams its calls in order, so the last running one
    // is what the model is typing now. Falls back to an earlier call when that
    // one has nothing to show yet (a write whose bytes haven't started).
    for (const call of [...calls].reverse()) {
      if (call.status !== "running") continue;
      const detail =
        call.name === "write_file"
          ? liveFileDetail(liveFiles.find((lf) => lf.id === call.id))
          : liveInputDetail(call);
      if (detail) {
        nodes.push(<div key={`live-${call.id}`} className="tc-live">{detail}</div>);
        break;
      }
    }
    buffer = [];
  };

  steps.forEach((step, i) => {
    if (step.type === "thought") {
      flush();
      nodes.push(
        <ThoughtStep key={`th-${i}`} content={step.content} streaming={isStreaming && i === steps.length - 1} />,
      );
      return;
    }
    if (step.type !== "tool") return;
    const c = step.call;
    if (c.name === "ask_user") { flush(); nodes.push(<AskUserStep key={c.id} call={c} />); return; }
    if (c.name === "show_widget") { flush(); nodes.push(<WidgetStep key={c.id} call={c} />); return; }
    buffer.push(c);
  });
  flush();

  return nodes;
}

/** Short display name Astryx shows in monospace next to the status icon. */
const TOOL_DISPLAY_NAME: Record<string, string> = {
  bash_tool: "bash",
  read_file: "read",
  list_dir: "list",
  read_photo: "read",
  write_file: "write",
  edit_file: "edit",
  read_skill: "skill",
  web_search: "web_search",
  web_fetch: "web_fetch",
};

/** Which input key holds the one argument worth previewing as `target`. */
const TARGET_ARG: Record<string, string> = {
  read_file: "path",
  list_dir: "path",
  read_photo: "path",
  write_file: "path",
  edit_file: "path",
  read_skill: "name",
  web_search: "query",
  web_fetch: "url",
};

/** The argument name the model fills in when `describe_actions` is on — shown as
 *  the row's own label, so it never doubles as an argument preview. */
const ACTIVITY_ARG = "activity";

function clip(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** First string argument of a call. Gives tools with no dedicated target key —
 *  MCP proxies, image_generate, anything added later — a live one-line preview
 *  instead of a bare tool name. */
function firstStringArg(input: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(input)) {
    if (key === ACTIVITY_ARG) continue;
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function targetFor(call: ToolCall): string {
  const activity = toolActivity(call);
  if (activity) return activity;
  if (call.name === "bash_tool") {
    const command = String(call.input?.command ?? "");
    return clip(command.split("\n")[0] ?? "");
  }
  const key = TARGET_ARG[call.name];
  if (key) {
    const raw = call.input[key];
    return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  }
  return clip(firstStringArg(call.input).replace(/\s+/g, " ").trim());
}

/** Longest slice of a streaming argument worth rendering. The *tail* is what
 *  matters mid-stream — that's where the model's caret is. */
const LIVE_PREVIEW_CHARS = 2000;

function argLanguage(toolName: string, key: string): string {
  if (toolName === "bash_tool") return "bash";
  if (key === "html") return "html";
  return "plaintext";
}

/** What the model is typing right now, for a call that hasn't run yet.
 *  Arguments stream in live (backend/agent/tool_stream.py), so this is where the
 *  user watches a call take shape — and can stop it — before it executes. */
function liveInputDetail(call: ToolCall): ReactNode | undefined {
  const entries = Object.entries(call.input ?? {}).filter(
    ([key, value]) => key !== ACTIVITY_ARG && value !== "" && value != null,
  );
  const first = entries[0];
  if (!first) return undefined;

  const soleText = entries.length === 1 && typeof first[1] === "string" ? first[1] : undefined;
  const code = soleText ?? JSON.stringify(Object.fromEntries(entries), null, 2);
  const language = soleText !== undefined ? argLanguage(call.name, first[0]) : "json";

  return <CodeBlock code={clipTail(code)} language={language} maxHeight="300px" isWrapped />;
}

/** The file taking shape under write_file, chunk by chunk. Its content never
 *  rides the tool call's arguments — it arrives as `tool_chunk` and is collected
 *  in `liveFiles` — so it needs its own reader. */
function liveFileDetail(liveFile: LiveFile | undefined): ReactNode | undefined {
  if (!liveFile || liveFile.done || liveFile.content.length === 0) return undefined;
  return (
    <CodeBlock
      code={clipTail(liveFile.content)}
      language={getLang(liveFile.path)}
      maxHeight="300px"
      isWrapped
    />
  );
}

function clipTail(code: string): string {
  return code.length > LIVE_PREVIEW_CHARS ? "…" + code.slice(-LIVE_PREVIEW_CHARS) : code;
}

function toChatStatus(status: ToolCallStatus): ChatToolCallStatus {
  return status === "running" ? "running" : status === "error" ? "error" : "complete";
}

function formatDuration(ms: number, t: TFunc): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}${t("chat.process.seconds")}`;
}

/** Best-effort language guess for a raw tool output string (mainly JSON vs
 * plain text), so CodeBlock picks up real syntax highlighting instead of
 * always falling back to "plaintext". */
function guessOutputLang(output: string): string {
  const trimmed = output.trim();
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
  return looksJson ? "json" : "plaintext";
}

function openArtifact(path: string) {
  window.dispatchEvent(new CustomEvent("open-artifact", { detail: path }));
}

function OpenInPanelButton({ path, label }: { path: string; label: string }) {
  return (
    <IconButton
      variant="ghost"
      size="sm"
      icon={<ArrowSquareOut />}
      label={label}
      tooltip={label}
      onClick={() => openArtifact(path)}
    />
  );
}

/** The call's arguments, formatted for reading rather than for a status line. */
function inputCode(call: ToolCall): { code: string; language: string } {
  if (call.name === "bash_tool") {
    return { code: String(call.input?.command ?? ""), language: "bash" };
  }
  const entries = Object.entries(call.input ?? {}).filter(([key]) => key !== ACTIVITY_ARG);
  return { code: JSON.stringify(Object.fromEntries(entries), null, 2), language: "json" };
}

/** Input and output side by side, one tab each.
 *
 *  The row's own header only ever shows the first 80 characters of the first
 *  line, so a multi-line command — or the arguments of a call that failed — had
 *  nowhere to be read in full. Output leads, because that is what you look at
 *  first; the input is one click away when the output needs explaining. */
function ToolIOTabs({ call, t }: { call: ToolCall; t: TFunc }) {
  const [active, setActive] = useState("output");
  const { code, language } = inputCode(call);

  return (
    <div className="tc-result-detail tc-io">
      <TabList value={active} onChange={setActive} size="sm">
        <Tab value="output" label={t("chat.toolCall.output")} />
        <Tab value="input" label={t("chat.toolCall.input")} />
      </TabList>
      {active === "output" ? (
        <CodeBlock
          code={call.output || t("chat.toolCall.emptyOutput")}
          language={call.name === "bash_tool" ? "bash" : guessOutputLang(call.output ?? "")}
          maxHeight="50vh"
        />
      ) : (
        <CodeBlock
          code={code || t("chat.toolCall.emptyInput")}
          language={language}
          maxHeight="50vh"
          isWrapped
        />
      )}
    </div>
  );
}

/** Builds one Astryx `ChatToolCalls` row from a raw ToolCall — folding in the
 * per-tool extras (live file preview, diff stats, source list, open-in-panel
 * affordance, ...) that used to live in bespoke Bash/Write/Edit/Skill/Mcp/
 * WebSearch step components. */
function buildToolCallItem(
  call: ToolCall,
  t: TFunc,
  opts: { liveFile?: LiveFile; webSearchMode?: string },
): ChatToolCallItem {
  const isRunning = call.status === "running";
  const mcp = parseMcpToolName(call.name);
  const statsNodes: ReactNode[] = [];

  const item: ChatToolCallItem = {
    key: call.id,
    name: mcp ? mcp.tool : (TOOL_DISPLAY_NAME[call.name] ?? call.name),
    node: mcp?.server,
    status: toChatStatus(call.status),
    target: targetFor(call),
    duration: !isRunning && call.durationMs != null ? formatDuration(call.durationMs, t) : undefined,
  };

  if (call.status === "error") {
    item.errorMessage = call.output?.slice(0, 300) || t("chat.toolCall.error");
  } else if (call.status === "cancelled") {
    statsNodes.push(<Badge key="cancelled" variant="neutral" label={t("chat.toolCall.cancelled")} />);
  }

  // A failed call is exactly when both halves matter: what came back, and what
  // was sent that produced it. Set before the per-tool switch so tools that
  // otherwise render nothing expandable (write_file, edit_file, read_skill)
  // still let the user open up the failure instead of just seeing a red cross.
  if (call.status === "error") {
    item.resultDetail = <ToolIOTabs call={call} t={t} />;
  }

  switch (call.name) {
    case "write_file": {
      // The file taking shape is rendered outside this row while the write
      // runs (see renderProcessSteps); once it completes the full file is one
      // click away in the artifacts side panel.
      const path = String(call.input?.path ?? "");
      if (path) statsNodes.push(<OpenInPanelButton key="open" path={path} label={t("chat.writeFile.openInPanel")} />);
      break;
    }
    case "edit_file": {
      const path = String(call.input?.path ?? "");
      const m = call.output?.match(/\+(\d+)\/-(\d+)/);
      if (m) {
        item.additions = Number(m[1]);
        item.deletions = Number(m[2]);
      }
      if (path) statsNodes.push(<OpenInPanelButton key="open" path={path} label={t("chat.editFile.openFile")} />);
      break;
    }
    case "read_skill": {
      if (call.filePath) {
        statsNodes.push(<OpenInPanelButton key="open" path={call.filePath} label={t("chat.writeFile.openInPanel")} />);
      }
      break;
    }
    case "bash_tool": {
      // Two tabs: the header can only show a truncated first line, so the full
      // command lives here next to what it printed.
      if (!isRunning) item.resultDetail = <ToolIOTabs call={call} t={t} />;
      break;
    }
    case "web_search": {
      const output = call.output ?? "";
      const modeLabel = opts.webSearchMode
        ? t(`chat.webSearch.modes.${opts.webSearchMode}`, { defaultValue: opts.webSearchMode })
        : "";
      if (modeLabel && !isRunning) {
        statsNodes.push(<Badge key="mode" variant="neutral" label={modeLabel} />);
      }
      if (!isRunning && output) {
        const agg = aggregateUrls(extractUrls(output));
        item.resultDetail = (
          <div className="tc-result-detail">
            {agg.total > 0 && <SourcesBox agg={agg} topN={6} />}
            <CodeBlock code={output} language={guessOutputLang(output)} maxHeight="50vh" />
          </div>
        );
      }
      break;
    }
    default: {
      if (isRunning) break;
      if (call.output) {
        item.resultDetail = (
          <div className="tc-result-detail">
            <CodeBlock code={call.output} language={guessOutputLang(call.output)} maxHeight="50vh" />
          </div>
        );
      } else if (call.input && Object.keys(call.input).length > 0) {
        item.resultDetail = (
          <div className="tc-result-detail">
            <CodeBlock code={JSON.stringify(call.input, null, 2)} language="json" maxHeight="50vh" />
          </div>
        );
      }
    }
  }

  if (statsNodes.length > 0) item.stats = <>{statsNodes}</>;
  return item;
}

function WidgetStep({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const title = typeof call.input?.title === "string" ? call.input.title.trim() : "";
  const isBuilding = call.status === "running";
  const isError = call.status === "error";

  return (
    <div className="thinking-step thinking-step--tool thinking-step--skill-read">
      <span className="skill-read-icon"><AppWindow size={14} /></span>
      <span className="skill-read-label">
        {toolActivity(call) || (isBuilding
          ? t("widget.building")
          : isError
            ? t("widget.error")
            : title
              ? t("widget.renderedNamed", { title })
              : t("widget.rendered"))}
      </span>
      {!isBuilding && !isError && call.durationMs != null && (
        <span className="skill-read-duration">
          {(call.durationMs / 1000).toFixed(1)}{t("chat.process.seconds")}
        </span>
      )}
    </div>
  );
}

/* ── Live widget preview (collapsible tool-call block) ─────────────── */

function WidgetPreviewBlock({ html, title }: { html: string; title?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <div className={`widget-preview-block thinking${open ? " expanded" : ""}`}>
      <div className="thinking-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}>
        <span className="thinking-ic"><AppWindow /></span>
        <span className="thinking-lbl">
          {title ? t("widget.renderedNamed", { title }) : t("widget.rendered")}
        </span>
        <span className="thinking-chev">{open ? <CaretDown /> : <CaretRight />}</span>
      </div>
      {open && (
        <div className="widget-preview-body thinking-body">
          <WidgetView html={html} title={title} />
        </div>
      )}
    </div>
  );
}

/* ── Iterations exhausted card ─────────────── */

function IterationsExhaustedCard({ count }: { count: number }) {
  const { t } = useTranslation();
  const newLimit = count * 2;

  const handleContinue = () => {
    window.dispatchEvent(new CustomEvent("iterations-continue", { detail: { count, newLimit } }));
  };

  const handleSettings = () => {
    window.dispatchEvent(new CustomEvent("navigate", { detail: "settings:models" }));
  };

  return (
    <div className="iter-exhausted-card">
      <div className="iter-exhausted-info">
        <Warning className="iter-exhausted-icon" weight="fill" size={16} />
        <span className="iter-exhausted-text">
          {t("chat.iterations.stopped", { count })}
        </span>
      </div>
      <div className="iter-exhausted-actions">
        <Button
          variant="primary"
          size="sm"
          label={t("chat.iterations.continue", { count: newLimit })}
          onClick={handleContinue}
        />
        <Button
          variant="secondary"
          size="sm"
          label={t("chat.iterations.settings")}
          onClick={handleSettings}
        />
      </div>
    </div>
  );
}

/* ── helpers ────────────────────────────────── */

function AskUserStep({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const questions = Array.isArray(call.input?.questions) ? call.input.questions : [];
  const n = questions.length;
  const label = n > 1 ? t("chat.askUser.askedN", { count: n }) : t("chat.askUser.asked");

  return (
    <div className="thinking-step thinking-step--tool thinking-step--skill-read">
      <span className="skill-read-icon"><Question size={13} /></span>
      <span className="skill-read-label">{label}</span>
      {call.status !== "running" && call.durationMs != null && (
        <span className="skill-read-duration">
          {(call.durationMs / 1000).toFixed(1)}{t("chat.process.seconds")}
        </span>
      )}
    </div>
  );
}

function NativeWebSearchChip() {
  const { t } = useTranslation();
  return (
    <div className="ws-native-chip">
      <Globe size={13} />
      <span>{t("chat.webSearch.nativeUsed")}</span>
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileIcon(name: string, mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (name.endsWith(".pdf")) return "📕";
  if (name.endsWith(".txt") || name.endsWith(".md")) return "📄";
  if (name.endsWith(".docx") || name.endsWith(".doc")) return "📝";
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) return "📊";
  if (name.endsWith(".pptx") || name.endsWith(".ppt")) return "📽";
  if (name.endsWith(".zip") || name.endsWith(".tar") || name.endsWith(".gz")) return "📦";
  return "📎";
}

function fileType(name: string, mime: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot > 0 && lastDot < name.length - 1) {
    const ext = name.slice(lastDot + 1).toUpperCase();
    if (ext.length <= 5) return ext;
  }
  if (mime.startsWith("image/")) return "IMG";
  if (mime.startsWith("text/")) return "TXT";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (mime.startsWith("video/")) return "VIDEO";
  return "FILE";
}

function ThoughtStep({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isLong = content.length > 220;

  // While streaming, keep the live window pinned to the newest reasoning so the
  // text flows upward and no control ever moves under the cursor.
  useEffect(() => {
    if (!streaming) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [content, streaming]);

  // Live reasoning: a fixed-height window, top-faded, no inline toggle — collapse
  // is the (stable) ProcessBlock header above.
  if (streaming) {
    return (
      <div className="thinking-step thinking-step--thought">
        <span className="thinking-gic thinking-gic--pulse"><Brain /></span>
        <div className="thought-live" ref={scrollRef}>
          <div className="thought-live-text">{content}</div>
        </div>
      </div>
    );
  }

  // Finished reasoning: content is static, so the expand/collapse sits in a fixed
  // place below the text and stays clickable.
  return (
    <div className="thinking-step thinking-step--thought">
      <span className="thinking-gic"><Brain /></span>
      <div className="thinking-text">
        <div className={`thought-body${isLong && !expanded ? " thought-body--clamped" : ""}`}>
          {content}
        </div>
        {isLong && (
          <button className="thought-expand-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t("chat.thought.collapse") : t("chat.thought.expand")}
          </button>
        )}
      </div>
    </div>
  );
}
