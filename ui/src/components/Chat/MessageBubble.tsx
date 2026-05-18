/** Single message bubble — user or assistant with process block, markdown, artifacts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, ArrowClockwise, CaretLeft, CaretRight, CaretDown, CaretUp } from "@phosphor-icons/react";
import { Brain, Spinner, CheckCircle } from "@phosphor-icons/react";
import { toolIcon, fileExtIcon } from "../../utils/toolIcons";
import { marked } from "marked";
import type { ChatMessage, AttachmentInfo } from "../../types/chat";
import type { ToolCall, ProcessStep } from "../../types/tool-call";
import { ToolCallBlock } from "../ToolCalls/ToolCallBlock";
import { ArtifactCard } from "../Artifacts/ArtifactCard";
import { CodeBlockView } from "./CodeBlockView";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { parseCodeBlocks } from "../../utils/parseCodeBlocks";
import { getLang } from "../../utils/getLang";
import { formatTime } from "../../utils/formatTime";
import type { LiveFile } from "../../types/artifact";

interface MessageBubbleProps {
  message: ChatMessage;
  liveFiles?: LiveFile[];
  onRetry?: () => void;
  isLastAssistantInBranch?: boolean;
  variantCount?: number;
  variantIndex?: number;
  nodeId?: string;
  onSwitchVariant?: (nodeId: string, idx: number) => void;
}

function parseMarkdown(src: string): string {
  const result = marked.parse(src);
  return typeof result === "string" ? result : "";
}

function MarkdownContent({ text }: { text: string }) {
  const html = parseMarkdown(text);
  const segments = parseCodeBlocks(html);

  return (
    <div className="msg-markdown">
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlockView key={i} language={seg.language} code={seg.code} />
        ) : seg.html ? (
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} />
        ) : null
      )}
    </div>
  );
}

export function MessageBubble({
  message, liveFiles = [], onRetry, isLastAssistantInBranch,
  variantCount = 0, variantIndex = 0, nodeId, onSwitchVariant,
}: MessageBubbleProps) {
  if (message.role === "user") {
    const hasAttachments = (message.attachments?.length ?? 0) > 0;
    return (
      <div className="msg msg-user">
        {hasAttachments && (
          <div className="msg-attach-chips">
            {message.attachments!.map((a) => (
              <div key={a.name} className="msg-attach-chip">
                <span className="msg-attach-chip-ic">{fileIcon(a.name, a.mime_type)}</span>
                <span className="msg-attach-chip-name">{a.name}</span>
                <span className="msg-attach-chip-size">{fmtSize(a.size)}</span>
                <span className="msg-attach-chip-type">{fileType(a.name, a.mime_type)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="msg-user-bubble">{message.content}</div>
        <div className="msg-user-time">{formatTime(message.timestamp)}</div>
        <MsgActions content={message.content} compact />
      </div>
    );
  }

  const steps = message.steps ?? [];
  const groups = splitStepGroups(steps);
  const isStreaming = !!(message.toolCalls?.some((tc) => tc.status === "running"));

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
      {hasContent && <div className="role-tag">assistant</div>}

      {groups.map((g, i) => {
        const procSteps = g.filter((s): s is Extract<ProcessStep, { type: "thought" | "tool" }> =>
          s.type === "thought" || s.type === "tool");
        const groupText = g
          .filter((s): s is Extract<ProcessStep, { type: "text" }> => s.type === "text")
          .map((s) => s.content)
          .join("");
        const isLast = i === groups.length - 1;
        const parsed = groupText ? parseArtifacts(groupText) : { cleanText: "", artifacts: [] };

        return (
          <div className="msg-group" key={i}>
            {procSteps.length > 0 && (
              <ProcessBlock
                steps={procSteps}
                isStreaming={isStreaming && isLast}
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

      {!isStreaming && <MsgActions content={message.content} onRetry={isLastAssistantInBranch ? onRetry : undefined} />}
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

function MsgActions({ content, onRetry, compact }: {
  content: string;
  onRetry?: () => void;
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
  write_file: "пишет файл",
  read_skill: "читает скилл",
  web_search: "ищет в вебе",
};
const TOOL_VERBS_PAST: Record<string, string> = {
  bash_tool: "выполнил команду",
  read_file: "прочитал файл",
  write_file: "записал файл",
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
            if (c.name === "bash_tool") {
              return <BashToolStep key={c.id} call={c} />;
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
            {!isRunning && !isError && call.durationMs != null && (
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
  const fileName = path.split("/").pop() ?? path;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = getLang(path);
  const isWriting = !!liveFile && !liveFile.done;
  const hasContent = !!(liveFile && liveFile.content.length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isWriting) return;
    if (stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [liveFile?.content, isWriting]);

  const handleStreamScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
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

        {hasContent && (
          <div className={`live-code-block${isWriting ? " live-code-block--writing" : ""}`}>
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

/* ── helpers ────────────────────────────────── */

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
