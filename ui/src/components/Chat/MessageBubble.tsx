/** Single message bubble — user or assistant with process block, markdown, artifacts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, ArrowClockwise, CaretLeft, CaretRight, CaretDown, CaretUp, PencilSimple, X } from "@phosphor-icons/react";
import { Brain, Spinner, CheckCircle, CaretDoubleDown, Warning } from "@phosphor-icons/react";
import { toolIcon, fileExtIcon } from "../../utils/toolIcons";
import { API_BASE } from "../../utils/apiBase";
import type { ChatMessage, AttachmentInfo } from "../../types/chat";
import type { ToolCall, ProcessStep } from "../../types/tool-call";
import { ToolCallBlock } from "../ToolCalls/ToolCallBlock";
import { ArtifactCard } from "../Artifacts/ArtifactCard";
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
        const parsed = groupText ? parseArtifacts(groupText) : { cleanText: "", artifacts: [] };

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
              />
            )}
            {parsed.cleanText.trim() && <MarkdownContent text={parsed.cleanText} />}
            {parsed.artifacts.map((a, j) => (
              <ArtifactCard key={`art-${i}-${j}`} artifact={a} />
            ))}
          </div>
        );
      })}

      {fallback && fallback.cleanText.trim() && <MarkdownContent text={fallback.cleanText} />}
      {fallback && fallback.artifacts.map((a, i) => (
        <ArtifactCard key={`art-fb-${i}`} artifact={a} />
      ))}

      {iterExhausted && <IterationsExhaustedCard count={iterExhausted.count} />}

      {!isGlobalStreaming && <MsgActions content={message.content} onRetry={isLastAssistantInBranch ? onRetry : undefined} />}
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
        placeholder="Отредактируй сообщение…"
      />
      <div className="msg-edit-actions">
        <button className="msg-edit-btn" onClick={onCancel} title="Отмена (Esc)">
          <X />
          <span>Отмена</span>
        </button>
        <button
          className="msg-edit-btn msg-edit-btn--primary"
          onClick={() => canSave && onSave(trimmed)}
          disabled={!canSave}
          title="Отправить (Ctrl+Enter)"
        >
          <Check />
          <span>Отправить</span>
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
  return (
    <div className="msg-variant-nav">
      <button
        className="msg-variant-arrow"
        disabled={current <= 1}
        onClick={onPrev}
        title="Предыдущий вариант"
      >
        <CaretLeft />
      </button>
      <span className="msg-variant-label">{current}/{total}</span>
      <button
        className="msg-variant-arrow"
        disabled={current >= total}
        onClick={onNext}
        title="Следующий вариант"
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
      <button className="msg-act-btn" title={copied ? "Скопировано" : "Копировать"} onClick={handleCopy}>
        {copied ? <Check /> : <Copy />}
      </button>
      {onEdit && (
        <button
          className="msg-act-btn"
          title={canEdit ? "Редактировать" : "Подожди ответ"}
          onClick={() => canEdit && onEdit()}
          disabled={!canEdit}
        >
          <PencilSimple />
        </button>
      )}
      {onRetry && (
        <button className="msg-act-btn" title="Повторить" onClick={() => onRetry()}>
          <ArrowClockwise />
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

const TOOL_VERBS_PRESENT: Record<string, string> = {
  bash_tool: "выполняет команду",
  read_file: "читает файл",
  read_photo: "смотрит фото",
  write_file: "пишет файл",
  edit_file: "редактирует файл",
  read_skill: "читает скилл",
  web_search: "ищет в вебе",
};
const TOOL_VERBS_PAST: Record<string, string> = {
  bash_tool: "выполнил команду",
  read_file: "прочитал файл",
  read_photo: "посмотрел фото",
  write_file: "записал файл",
  edit_file: "отредактировал файл",
  read_skill: "прочитал скилл",
  web_search: "поискал в вебе",
};

function buildProcessTitle(steps: ProcessStep[], streaming: boolean): string {
  const tools = steps.filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool");
  const hasThoughts = steps.some((s) => s.type === "thought");

  if (tools.length === 0) {
    return streaming ? "Думает…" : "Подумал";
  }

  const verbMap = streaming ? TOOL_VERBS_PRESENT : TOOL_VERBS_PAST;
  const seen = new Set<string>();
  const verbs: string[] = [];
  for (const t of tools) {
    if (seen.has(t.call.name)) continue;
    seen.add(t.call.name);
    verbs.push(verbMap[t.call.name] ?? t.call.name);
  }

  let phrase = verbs.join(", ");
  if (hasThoughts) {
    phrase = (streaming ? "Думает, " : "Подумал, ") + phrase;
  } else {
    phrase = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }
  return phrase + (streaming ? "…" : "");
}

function ProcessBlock({
  steps, isStreaming, liveFiles,
}: {
  steps: ProcessStep[];
  isStreaming: boolean;
  liveFiles: LiveFile[];
}) {
  const [open, setOpen] = useState(false);

  // Auto-open while streaming so the live preview is visible
  useEffect(() => { if (isStreaming) setOpen(true); }, [isStreaming]);

  const toolCalls = steps.filter((s): s is { type: "tool"; call: ToolCall } => s.type === "tool");
  const totalMs = toolCalls.reduce((sum, s) => sum + (s.call.durationMs ?? 0), 0);
  const title = buildProcessTitle(steps, isStreaming);

  return (
    <div className="thinking">
      <div className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-ic">
          {isStreaming ? <Spinner className="thinking-spin" /> : <CheckCircle />}
        </span>
        <span className="thinking-lbl">{title}</span>
        {toolCalls.length > 0 && !isStreaming && totalMs > 0 && (
          <span className="thinking-meta">{(totalMs / 1000).toFixed(1)} с</span>
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
            <span className="bash-head-cmd">{preview || "(пустая команда)"}</span>
            {isRunning && <span className="bash-status running">⟳</span>}
            {isError && <span className="bash-status err">✗ ошибка</span>}
            {isCancelled && <span className="bash-status cancelled">⏹ отменено</span>}
            {!isRunning && !isError && !isCancelled && call.durationMs != null && (
              <span className="bash-status">{(call.durationMs / 1000).toFixed(1)}с</span>
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
                  <div className="bash-card-lbl">Output</div>
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
          {isWriting ? "Записываю" : "Записал"}
          <button className="tc-write-badge" onClick={openInPanel} title="Открыть в панели">
            {fileName}
          </button>
          {call.status === "error" && <span className="tc-write-err">ошибка</span>}
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
          {isEditing ? "Редактирую" : "Отредактировал"}
          <button className="tc-write-badge" onClick={openInPanel} title="Открыть файл">
            {fileName}
          </button>
          {isError && (
            <span className="tc-write-err" title={call.output}>
              {call.output?.slice(0, 80) || "ошибка"}
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

function pluralIterations(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return "итераций";
  if (mod10 === 1) return "итерация";
  if (mod10 >= 2 && mod10 <= 4) return "итерации";
  return "итераций";
}

function IterationsExhaustedCard({ count }: { count: number }) {
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
          Агент остановлен — исчерпано {count} {pluralIterations(count)}
        </span>
      </div>
      <div className="iter-exhausted-actions">
        <button className="iter-exhausted-btn iter-exhausted-btn--primary" onClick={handleContinue}>
          Продолжить (увеличить до {newLimit})
        </button>
        <button className="iter-exhausted-btn" onClick={handleSettings}>
          Настройки
        </button>
      </div>
    </div>
  );
}

/* ── helpers ────────────────────────────────── */

function SkillReadStep({ call }: { call: ToolCall }) {
  const skillName = String(call.input?.name ?? "");
  const label = call.status === "running"
    ? `Reading the ${skillName} skill`
    : `Read the ${skillName} skill`;

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
          {call.durationMs != null ? `${(call.durationMs / 1000).toFixed(1)}s` : ""}
        </span>
      )}
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
              развернуть
            </button>
          </>
        ) : (
          <>
            {content}
            {isLong && (
              <> <button className="thought-expand-btn" onClick={() => setExpanded(false)}>
                свернуть
              </button></>
            )}
          </>
        )}
      </div>
    </div>
  );
}
