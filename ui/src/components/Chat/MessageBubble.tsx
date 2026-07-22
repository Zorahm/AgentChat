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
import { parseMcpToolName } from "../../utils/mcpName";
import { API_BASE, withToken } from "../../utils/apiBase";
import type { ChatMessage, AttachmentInfo, MessageUsage } from "../../types/chat";
import type { ToolCall, ToolCallStatus, ProcessStep } from "../../types/tool-call";
import { ResearchCard } from "./ResearchCard";
import { SourcesBox } from "./SourcesBox";
import { aggregateUrls, extractUrls } from "../../utils/research";
import { ArtifactCard } from "../Artifacts/ArtifactCard";
import { WidgetView, WidgetSkeleton } from "../Artifacts/WidgetView";
import { SupportCard } from "./SupportCard";
import { Markdown } from "@astryxdesign/core/Markdown";
import { latexMarkdownPlugins } from "../../utils/latexPlugins";
import { ChatMessage as ChatMsg, ChatMessageBubble, ChatMessageMetadata, ChatToolCalls } from "@astryxdesign/core/Chat";
import type { ChatToolCallItem, ChatToolCallStatus } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { presentedArtifacts } from "../../utils/presentedFiles";
import { getLang } from "../../utils/getLang";
import { basename } from "../../utils/basename";
import { toolActivity } from "../../utils/toolActivity";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import type { LiveFile } from "../../types/artifact";
import { Question } from "@phosphor-icons/react";

interface MessageBubbleProps {
  message: ChatMessage;
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
}

function MarkdownContent({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Markdown display="block" isStreaming={streaming} className="msg-markdown" inlinePlugins={latexMarkdownPlugins}>
      {text}
    </Markdown>
  );
}

export function MessageBubble({
  message, liveFiles = [], onRetry, onEdit, canEdit = false, isLastAssistantInBranch,
  isGlobalStreaming = false, variantCount = 0, variantIndex = 0, nodeId, onSwitchVariant,
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
    <ChatMsg sender="assistant" className="msg msg-assistant">
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

        // Widgets render directly under the call that produced them — a skeleton
        // while the model is still generating the HTML, the live widget once the
        // call succeeds (the full HTML lives in the persisted tool input).
        const groupWidgets = procSteps
          .filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool")
          .map((s) => s.call)
          .filter((c) => c.name === "show_widget");

        // Research renders as its own card (Claude-style) — clicking it opens the
        // side-panel timeline. It's lifted OUT of the collapsed process block.
        const groupResearch = procSteps
          .filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool")
          .map((s) => s.call)
          .filter((c) => c.name === "research");
        // present_files surfaces its results as ArtifactCards below the message
        // (see `presented`), so its raw tool call is lifted out of the process
        // block — otherwise it shows up twice and looks like a stray tool.
        const visibleProc = procSteps.filter(
          (s) => !(s.type === "tool" && (s.call.name === "research" || s.call.name === "present_files")),
        );

        // Spinner while: any tool in this group is still running,
        // OR the global SSE stream is active but this group has no text yet
        // (tools just completed, model hasn't responded yet).
        // Non-last groups are always done — checkmark.
        // Research has its own card + spinner, so it doesn't drive the process
        // block's streaming state (visibleProc excludes it).
        const anyGroupToolRunning = visibleProc
          .filter((s): s is Extract<ProcessStep, { type: "tool" }> => s.type === "tool")
          .some((s) => s.call.status === "running");
        const blockStreaming = isLast && (anyGroupToolRunning || (isGlobalStreaming && !groupText));

        return (
          <div className="msg-group" key={i}>
            {visibleProc.length > 0 && (
              <ProcessBlock
                steps={visibleProc}
                isStreaming={blockStreaming}
                liveFiles={liveFiles}
                webSearchMode={message.webSearchMode}
              />
            )}
            {groupResearch.map((c) => (
              <ResearchCard key={`research-${c.id}`} call={c} />
            ))}
            {groupWidgets.map((c) => {
              const wTitle = typeof c.input?.title === "string" ? c.input.title : undefined;
              if (c.status === "success" && typeof c.input?.html === "string") {
                return <WidgetPreviewBlock key={`widget-${c.id}`} html={String(c.input.html ?? "")} title={wTitle} />;
              }
              if (c.status === "running") {
                return <WidgetSkeleton key={`widget-${c.id}`} title={wTitle} />;
              }
              return null;
            })}
            {parsed.cleanText.trim() && (
              <ChatMessageBubble variant="ghost">
                <MarkdownContent text={parsed.cleanText} streaming={blockStreaming} />
              </ChatMessageBubble>
            )}
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

      {/* Nothing streamed yet — reassure the user the model is still alive. */}
      {isGlobalStreaming && !hasContent && <ThinkingIndicator />}

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
}

function UserBubble({
  message, onEdit, canEdit, variantCount, variantIndex, nodeId, onSwitchVariant,
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
      <div className="msg msg-user msg-user--editing">
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
    <ChatMsg sender="user" className="msg msg-user">
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
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
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
  read_photo: "path",
  write_file: "path",
  edit_file: "path",
  read_skill: "name",
  web_search: "query",
  web_fetch: "url",
};

function targetFor(call: ToolCall): string {
  const activity = toolActivity(call);
  if (activity) return activity;
  if (call.name === "bash_tool") {
    const command = String(call.input?.command ?? "");
    const firstLine = command.split("\n")[0] ?? "";
    return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
  }
  const key = TARGET_ARG[call.name];
  const raw = key ? call.input[key] : undefined;
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
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

  switch (call.name) {
    case "write_file": {
      const path = String(call.input?.path ?? "");
      const liveFile = opts.liveFile;
      // Live preview shows ONLY while actively writing — once the write
      // completes the liveFile entry is gone, and the full file is one click
      // away in the artifacts side panel via the open button below.
      if (liveFile && !liveFile.done && liveFile.content.length > 0) {
        item.resultDetail = (
          <div className="tc-result-detail">
            <CodeBlock code={liveFile.content} language={getLang(path)} maxHeight="300px" isWrapped />
          </div>
        );
      }
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
      if (!isRunning && call.output) {
        item.resultDetail = (
          <div className="tc-result-detail">
            <CodeBlock code={call.output} language="bash" maxHeight="50vh" />
          </div>
        );
      }
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
