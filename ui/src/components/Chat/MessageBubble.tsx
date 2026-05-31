/** Single message bubble — user or assistant with process block, markdown, artifacts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, ArrowClockwise, CaretLeft, CaretRight, CaretDown, CaretUp, PencilSimple, X } from "@phosphor-icons/react";
import { Brain, Spinner, CheckCircle, CaretDoubleDown, Warning, Plugs, Globe } from "@phosphor-icons/react";
import { toolIcon, fileExtIcon } from "../../utils/toolIcons";
import { parseMcpToolName } from "../../utils/mcpName";
import { API_BASE } from "../../utils/apiBase";
import type { ChatMessage, AttachmentInfo } from "../../types/chat";
import type { ToolCall, ProcessStep } from "../../types/tool-call";
import { ToolCallBlock } from "../ToolCalls/ToolCallBlock";
import { ArtifactCard } from "../Artifacts/ArtifactCard";
import { SupportCard } from "./SupportCard";
import { Markdown } from "../Markdown/Markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { getLang } from "../../utils/getLang";
import { basename } from "../../utils/basename";
import { formatTime } from "../../utils/formatTime";
import type { LiveFile } from "../../types/artifact";
import { BookOpen } from "@phosphor-icons/react";

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

function MarkdownContent({ text }: { text: string }) {
  return <Markdown text={text} className="msg-markdown" breaks={true} math={true} />;
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

  const hasContent = useFallback || groups.length > 0;
  const hasVariants = variantCount > 1;

  return (
    <div className="msg msg-assistant">
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
        const parsed = groupText ? parseArtifacts(groupText) : { cleanText: "", artifacts: [], support: false };

        // Spinner while: any tool in this group is still running,
        // OR the global SSE stream is active but this group has no text yet
        // (tools just completed, model hasn't responded yet).
        // Non-last groups are always done — checkmark.
        const anyGroupToolRunning = procSteps
          .filter((s): s is Extract<ProcessStep, { type: "tool" }> => s.type === "tool")
          .some((s) => s.call.status === "running");
        const blockStreaming = isLast && (anyGroupToolRunning || (isGlobalStreaming && !groupText));

        return (
          <div className="msg-group" key={i}>
            {procSteps.length > 0 && (
              <ProcessBlock
                steps={procSteps}
                isStreaming={blockStreaming}
                liveFiles={liveFiles}
                webSearchMode={message.webSearchMode}
              />
            )}
            {parsed.cleanText.trim() && <MarkdownContent text={parsed.cleanText} />}
            {parsed.artifacts.map((a, j) => (
              <ArtifactCard key={`art-${i}-${j}`} artifact={a} />
            ))}
            {parsed.support && <SupportCard />}
          </div>
        );
      })}

      {fallback && fallback.cleanText.trim() && <MarkdownContent text={fallback.cleanText} />}
      {fallback && fallback.artifacts.map((a, i) => (
        <ArtifactCard key={`art-fb-${i}`} artifact={a} />
      ))}
      {fallback && fallback.support && <SupportCard />}

      {/* Nothing streamed yet — reassure the user the model is still alive. */}
      {isGlobalStreaming && !hasContent && <ThinkingIndicator />}

      {message.webSearchMode === "native" && <NativeWebSearchChip />}

      {iterExhausted && <IterationsExhaustedCard count={iterExhausted.count} />}

      {!isGlobalStreaming && <MsgActions content={parseArtifacts(message.content).cleanText} onRetry={isLastAssistantInBranch ? onRetry : undefined} />}
    </div>
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
  const legacyHtml = !message.displayHtml &&
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
    <div className="msg msg-user">
      {hasAttachments && (() => {
        const images = message.attachments!.filter((a) => a.mime_type.startsWith("image/"));
        const files = message.attachments!.filter((a) => !a.mime_type.startsWith("image/"));
        return (
          <>
            {images.length > 0 && (
              <div className="msg-img-row">
                {images.map((a) => {
                  const src = a.data_url
                    ?? (a.path ? `${API_BASE}/files/serve?path=${encodeURIComponent(a.path)}` : null);
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
      {isLong && (
        <button className="msg-expand-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <CaretUp size={12} /> : <CaretDoubleDown size={12} />}
        </button>
      )}
      <div className="msg-user-foot">
        <div className="msg-user-time">{formatTime(message.timestamp)}</div>
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
    </div>
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
        <button className="msg-edit-btn" onClick={onCancel} title={t("chat.cancelEsc")}>
          <X />
          <span>{t("chat.cancel")}</span>
        </button>
        <button
          className="msg-edit-btn msg-edit-btn--primary"
          onClick={() => canSave && onSave(trimmed)}
          disabled={!canSave}
          title={t("chat.sendCtrlEnter")}
        >
          <Check />
          <span>{t("chat.send")}</span>
        </button>
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
      <button
        className="msg-variant-arrow"
        disabled={current <= 1}
        onClick={onPrev}
        title={t("chat.previousVariant")}
      >
        <CaretLeft />
      </button>
      <span className="msg-variant-label">{current}/{total}</span>
      <button
        className="msg-variant-arrow"
        disabled={current >= total}
        onClick={onNext}
        title={t("chat.nextVariant")}
      >
        <CaretRight />
      </button>
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
      <button className="msg-act-btn" title={copied ? t("chat.copied") : t("chat.copy")} onClick={handleCopy}>
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </button>
      {onEdit && (
        <button
          className="msg-act-btn"
          title={canEdit ? t("chat.edit") : t("chat.waitForResponse")}
          onClick={() => canEdit && onEdit()}
          disabled={!canEdit}
        >
          <PencilSimple size={18} />
        </button>
      )}
      {onRetry && (
        <button className="msg-act-btn" title={t("chat.retry")} onClick={() => onRetry()}>
          <ArrowClockwise size={18} />
        </button>
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
  };
  const TOOL_VERBS_PAST: Record<string, string> = {
    bash_tool: t("chat.tools.bash.past"),
    read_file: t("chat.tools.readFile.past"),
    read_photo: t("chat.tools.readPhoto.past"),
    write_file: t("chat.tools.writeFile.past"),
    edit_file: t("chat.tools.editFile.past"),
    read_skill: t("chat.tools.readSkill.past"),
    web_search: t("chat.tools.webSearch.past"),
  };

  if (tools.length === 0) {
    return streaming ? t("chat.process.thinking") : t("chat.process.thought");
  }

  const verbMap = streaming ? TOOL_VERBS_PRESENT : TOOL_VERBS_PAST;
  const seen = new Set<string>();
  const verbs: string[] = [];
  for (const tool of tools) {
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
      <div className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-ic">
          {isStreaming ? <Spinner className="thinking-spin" /> : <CheckCircle />}
        </span>
        <span className="thinking-lbl">{title}</span>
        {toolCalls.length > 0 && !isStreaming && totalMs > 0 && (
          <span className="thinking-meta">{(totalMs / 1000).toFixed(1)}{t("chat.process.seconds")}</span>
        )}
        <span className="thinking-chev">{open ? <CaretDown /> : <CaretRight />}</span>
      </div>

      {open && (
        <div className="thinking-body">
          {steps.map((step, i) => {
            if (step.type === "thought") {
              return <ThoughtStep key={i} content={step.content} />;
            }
            if (step.type !== "tool") return null;
            const c = step.call;
            if (c.name === "write_file") {
              return (
                <WriteFileStep
                  key={c.id}
                  call={c}
                  liveFile={liveFiles.find((lf) => lf.id === c.id)}
                />
              );
            }
            if (c.name === "edit_file") {
              return <EditFileStep key={c.id} call={c} />;
            }
            if (c.name === "bash_tool") {
              return <BashToolStep key={c.id} call={c} />;
            }
            if (c.name === "read_skill") {
              return <SkillReadStep key={c.id} call={c} />;
            }
            if (c.name.startsWith("mcp__")) {
              return <McpToolStep key={c.id} call={c} />;
            }
            if (c.name === "web_search") {
              return <WebSearchStep key={c.id} call={c} mode={webSearchMode} />;
            }
            return (
              <div key={c.id} className="thinking-step thinking-step--tool">
                <span className="thinking-gic">{toolIcon(c.name)}</span>
                <div className="thinking-content">
                  <ToolCallBlock call={c} inline={true} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BashToolStep({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const command = String(call.input?.command ?? "");
  const firstLine = command.split("\n")[0] ?? "";
  const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
  const isRunning = call.status === "running";
  const isError = call.status === "error";
  const isCancelled = call.status === "cancelled";

  return (
    <div className="thinking-step thinking-step--tool">
      <span className="thinking-gic">{toolIcon("bash_tool")}</span>
      <div className="thinking-content">
        <div className={`bash-step${expanded ? " expanded" : ""}`}>
          <div className="bash-head" onClick={() => setExpanded((v) => !v)}>
            <span className="bash-head-tag">bash</span>
            <span className="bash-head-cmd">{preview || t("chat.bash.emptyCommand")}</span>
            {isRunning && <span className="bash-status running">⟳</span>}
            {isError && <span className="bash-status err">✗ {t("chat.bash.error")}</span>}
            {isCancelled && <span className="bash-status cancelled">⏹ {t("chat.bash.cancelled")}</span>}
            {!isRunning && !isError && !isCancelled && call.durationMs != null && (
              <span className="bash-status">{(call.durationMs / 1000).toFixed(1)}{t("chat.bash.seconds")}</span>
            )}
            <span className="bash-chev">{expanded ? <CaretUp /> : <CaretDown />}</span>
          </div>

          {expanded && (
            <div className="bash-body">
              <div className="bash-card">
                <div className="bash-card-lbl">bash</div>
                <div className="bash-card-content">
                  <SyntaxHighlighter
                    language="bash"
                    style={atomDark}
                    customStyle={{
                      margin: 0,
                      padding: "4px 12px 10px",
                      background: "transparent",
                      fontSize: "12px",
                      lineHeight: "1.6",
                    }}
                  >
                    {command}
                  </SyntaxHighlighter>
                </div>
              </div>

              {!isRunning && call.output && (
                <div className="bash-card">
                  <div className="bash-card-lbl">{t("chat.bash.output")}</div>
                  <pre className="bash-output">{call.output}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WriteFileStep({ call, liveFile }: { call: ToolCall; liveFile?: LiveFile }) {
  const { t } = useTranslation();
  const path = String(call.input?.path ?? "");
  const fileName = basename(path);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = getLang(path);
  const isWriting = !!liveFile && !liveFile.done;
  // Inline preview shows ONLY while actively writing. As soon as the write
  // completes, the panel collapses to just the filename badge — the full file
  // is one click away in the artifacts side panel.
  const showLivePreview = isWriting && !!liveFile && liveFile.content.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !showLivePreview) return;
    if (stickBottom.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
    }
  }, [liveFile?.content, showLivePreview]);

  // Distinguish user scrolls from programmatic scrolls: programmatic ones
  // come right after we set scrollTop in the effect, so they match
  // lastScrollTop. Anything else is the user.
  const handleStreamScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const programmatic = el.scrollTop === lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    if (programmatic) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const openInPanel = () =>
    window.dispatchEvent(new CustomEvent("open-artifact", { detail: path }));

  const previewContent = liveFile
    ? liveFile.content.split("\n").slice(-40).join("\n")
    : "";

  return (
    <div className="thinking-step thinking-step--tool">
      <span className="thinking-gic">{fileExtIcon(ext)}</span>
      <div className="thinking-content">
        <div className="tc-write-label">
          {isWriting ? t("chat.writeFile.writing") : t("chat.writeFile.wrote")}
          <button className="tc-write-badge" onClick={openInPanel} title={t("chat.writeFile.openInPanel")}>
            {fileName}
          </button>
          {call.status === "error" && <span className="tc-write-err">{t("chat.writeFile.error")}</span>}
        </div>

        {showLivePreview && (
          <div className="live-code-block live-code-block--writing">
            {ext && <div className="live-code-lang">{ext}</div>}
            <div className="live-code-scroll" ref={scrollRef} onScroll={handleStreamScroll}>
              <SyntaxHighlighter
                language={lang}
                style={atomDark}
                customStyle={{
                  margin: 0,
                  padding: "6px 12px 10px",
                  background: "transparent",
                  fontSize: "12px",
                  lineHeight: "1.6",
                }}
              >
                {previewContent}
              </SyntaxHighlighter>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EditFileStep({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const path = String(call.input?.path ?? "");
  const fileName = basename(path);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isEditing = call.status === "running";
  const isError = call.status === "error";

  const stats = (() => {
    if (!call.output) return null;
    const m = call.output.match(/\+(\d+)\/-(\d+)/);
    if (!m) return null;
    return { added: Number(m[1]), removed: Number(m[2]) };
  })();

  const openInPanel = () =>
    window.dispatchEvent(new CustomEvent("open-artifact", { detail: path }));

  return (
    <div className="thinking-step thinking-step--tool">
      <span className="thinking-gic">{fileExtIcon(ext)}</span>
      <div className="thinking-content">
        <div className="tc-write-label">
          {isEditing ? t("chat.editFile.editing") : t("chat.editFile.edited")}
          <button className="tc-write-badge" onClick={openInPanel} title={t("chat.editFile.openFile")}>
            {fileName}
          </button>
          {isError && (
            <span className="tc-write-err" title={call.output}>
              {call.output?.slice(0, 80) || t("chat.editFile.error")}
            </span>
          )}
          {!isEditing && !isError && stats && (
            <span className="tc-edit-stats">
              <span className="tc-edit-add">+{stats.added}</span>
              <span className="tc-edit-del">-{stats.removed}</span>
            </span>
          )}
        </div>
      </div>
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
        <button className="iter-exhausted-btn iter-exhausted-btn--primary" onClick={handleContinue}>
          {t("chat.iterations.continue", { count: newLimit })}
        </button>
        <button className="iter-exhausted-btn" onClick={handleSettings}>
          {t("chat.iterations.settings")}
        </button>
      </div>
    </div>
  );
}

/* ── helpers ────────────────────────────────── */

function SkillReadStep({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const skillName = String(call.input?.name ?? "");
  const label = call.status === "running"
    ? t("chat.skill.reading", { skillName })
    : t("chat.skill.read", { skillName });

  const handleClick = () => {
    const filePath = call.filePath;
    if (filePath) {
      window.dispatchEvent(new CustomEvent("open-artifact", { detail: filePath }));
    }
  };

  return (
    <div className="thinking-step thinking-step--tool thinking-step--skill-read">
      <span className="skill-read-icon"><BookOpen size={14} /></span>
      <button
        className={`skill-read-label${call.filePath ? " skill-read-label--link" : ""}`}
        onClick={call.filePath ? handleClick : undefined}
        disabled={!call.filePath}
      >
        {label}
      </button>
      {!call.filePath && call.status !== "running" && (
        <span className="skill-read-duration">
          {call.durationMs != null ? `${(call.durationMs / 1000).toFixed(1)}${t("chat.skill.seconds")}` : ""}
        </span>
      )}
    </div>
  );
}

function McpToolStep({ call }: { call: ToolCall }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"input" | "output">("input");

  const parsed = parseMcpToolName(call.name);
  const server = parsed?.server ?? "mcp";
  const tool = parsed?.tool ?? call.name;

  const isRunning = call.status === "running";
  const isError = call.status === "error";
  const isCancelled = call.status === "cancelled";
  const inputStr = call.input != null ? JSON.stringify(call.input, null, 2) : "";

  return (
    <div className="thinking-step thinking-step--tool">
      <span className="thinking-gic"><Plugs size={14} /></span>
      <div className="thinking-content">
        <div className={`mcp-step${expanded ? " expanded" : ""}`}>
          <div className="mcp-head" onClick={() => setExpanded((v) => !v)}>
            <span className="mcp-head-badge" title={t("chat.mcp.serverTitle", { server })}>{server}</span>
            <span className="mcp-head-tool">{tool}</span>
            {isRunning && <span className="mcp-status running">⟳</span>}
            {isError && <span className="mcp-status err">✗ {t("chat.mcp.error")}</span>}
            {isCancelled && <span className="mcp-status cancelled">⏹ {t("chat.mcp.cancelled")}</span>}
            {!isRunning && !isError && !isCancelled && call.durationMs != null && (
              <span className="mcp-status">{(call.durationMs / 1000).toFixed(1)}{t("chat.mcp.seconds")}</span>
            )}
            <span className="mcp-chev">{expanded ? <CaretUp /> : <CaretDown />}</span>
          </div>

          {expanded && (
            <div className="tc-body">
              <div className="tc-tabs">
                <button
                  className={`tc-tab${tab === "input" ? " active" : ""}`}
                  onClick={() => setTab("input")}
                >
                  {t("chat.mcp.input")}
                </button>
                {!isRunning && (
                  <button
                    className={`tc-tab${tab === "output" ? " active" : ""}`}
                    onClick={() => setTab("output")}
                  >
                    {t("chat.mcp.output")}
                  </button>
                )}
              </div>
              <pre className="tc-pre">
                {tab === "input"
                  ? inputStr || t("chat.mcp.noInput")
                  : call.output || t("chat.mcp.noOutput")}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WebSearchStep({ call, mode }: { call: ToolCall; mode?: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const query = String(call.input?.query ?? "");
  const output = call.output ?? "";
  const isRunning = call.status === "running";
  const isError = call.status === "error" || output.startsWith("[web_search error]");

  // Result count is parsed from the tool output header "— N result(s):".
  const match = output.match(/—\s*(\d+)\s+result/);
  const count = match ? Number(match[1]) : null;
  // litellm mode is branded "Tavily" in the UI.
  const modeLabel = mode ? t(`chat.webSearch.modes.${mode}`, { defaultValue: mode }) : "";

  return (
    <div className="thinking-step thinking-step--tool">
      <span className="thinking-gic"><Globe size={14} /></span>
      <div className="thinking-content">
        <div className={`mcp-step${expanded ? " expanded" : ""}`}>
          <div className="mcp-head" onClick={() => setExpanded((v) => !v)}>
            <span className="mcp-head-badge">
              {isRunning
                ? t("chat.webSearch.searching")
                : count != null
                  ? t("chat.webSearch.results", { count })
                  : t("chat.webSearch.searched")}
            </span>
            <span className="mcp-head-tool">{query}</span>
            {modeLabel && !isRunning && <span className="ws-mode-tag">{modeLabel}</span>}
            {isRunning && <span className="mcp-status running">⟳</span>}
            {isError && <span className="mcp-status err">✗</span>}
            {!isRunning && !isError && call.durationMs != null && (
              <span className="mcp-status">{(call.durationMs / 1000).toFixed(1)}{t("chat.webSearch.seconds")}</span>
            )}
            <span className="mcp-chev">{expanded ? <CaretUp /> : <CaretDown />}</span>
          </div>
          {expanded && (
            <div className="tc-body">
              <pre className="tc-pre">{output || t("chat.webSearch.noOutput")}</pre>
            </div>
          )}
        </div>
      </div>
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

function ThoughtStep({ content }: { content: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 200;
  const preview = content.slice(0, 200).replace(/\n+/g, " ").trimEnd();

  return (
    <div className="thinking-step thinking-step--thought">
      <span className="thinking-gic"><Brain /></span>
      <div className="thinking-text">
        {isLong && !expanded ? (
          <>
            {preview}{"… "}
            <button className="thought-expand-btn" onClick={() => setExpanded(true)}>
              {t("chat.thought.expand")}
            </button>
          </>
        ) : (
          <>
            {content}
            {isLong && (
              <> <button className="thought-expand-btn" onClick={() => setExpanded(false)}>
                {t("chat.thought.collapse")}
              </button></>
            )}
          </>
        )}
      </div>
    </div>
  );
}
