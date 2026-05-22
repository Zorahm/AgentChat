/** Chat input — TipTap editor with @mentions + file attachments. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, X, Plus } from "@phosphor-icons/react";
import { EditorContent, useEditor, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { ModelItem } from "./ChatView";
import { ModelSelector } from "./ModelSelector";
import type { AttachmentInfo } from "../../types/chat";
import { buildMentionSuggestion, extractText } from "../../utils/mentions";
import { MentionNodeView } from "./MentionNodeView";
import { API_BASE } from "../../utils/apiBase";

interface ChatInputProps {
  onSend: (text: string, attachments: AttachmentInfo[], html?: string) => void;
  onStop: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  models: ModelItem[];
  model: string;
  onModelChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  placeholder?: string;
  fillText?: string;
  onFillTextConsumed?: () => void;
  dirSlug?: string | null;
}

interface PendingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  content: string | null;
  dataUrl: string | null;
  uploading: boolean;
  error: string | null;
  uploadedPath?: string;
}

let _fid = 1;
const nextFid = () => String(_fid++);

export function ChatInput({
  onSend, onStop, disabled, isStreaming,
  models, model, onModelChange, thinkingEnabled, onThinkingToggle,
  placeholder = "Message…",
  fillText, onFillTextConsumed,
  dirSlug,
}: ChatInputProps) {
  const [textLen, setTextLen] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bind the mention popup's "attach file" action to our file input.
  const mentionSuggestion = useRef(
    buildMentionSuggestion({
      onAttachFile: () => fileInputRef.current?.click(),
    }),
  ).current;

  /* ── send ─────────────────────────────────── */

  const handleSend = useCallback(async () => {
    if (!editorRef.current) return;
    const html = editorRef.current.getHTML();
    const text = extractText(editorRef.current.getJSON());
    if ((!text.trim() && pendingFiles.length === 0) || disabled) return;

    // Upload everything that isn't already on disk. Text files (.txt/.md) are
    // skipped because their `content` is read inline. Images go through too —
    // the dataUrl is for vision blocks, but the file itself must also live in
    // chats/<slug>/uploads/ so the model can re-read or transform it via bash.
    const needUpload = pendingFiles.filter(
      (pf) => !pf.content && !pf.uploading && !pf.uploadedPath
    );
    const finalFiles = [...pendingFiles];

    if (needUpload.length > 0) {
      setPendingFiles((prev) =>
        prev.map((pf) =>
          needUpload.some((n) => n.id === pf.id) ? { ...pf, uploading: true } : pf
        )
      );

      const form = new FormData();
      for (const pf of needUpload) {
        form.append("files", pf.file);
      }
      if (dirSlug) form.append("chat_dir_slug", dirSlug);
      try {
        const r = await fetch(`${API_BASE}/files/upload`, { method: "POST", body: form });
        if (r.ok) {
          const uploaded: Array<{ name: string; path: string; size: number; mime_type: string; content?: string }> = await r.json();
          for (const up of uploaded) {
            const idx = finalFiles.findIndex((pf) => pf.name === up.name && pf.uploading);
            if (idx >= 0) {
              finalFiles[idx] = {
                ...finalFiles[idx]!,
                content: up.content ?? finalFiles[idx]!.content,
                uploading: false,
                uploadedPath: up.path,
              };
            }
          }
        }
      } catch { /* upload failed — try anyway, model can read from path */ }
    }

    const attachments: AttachmentInfo[] = finalFiles
      .filter((pf) => !pf.error)
      .map((pf) => ({
        name: pf.name,
        path: pf.uploadedPath ?? null,
        size: pf.size,
        mime_type: pf.type,
        content: pf.content,
        data_url: pf.dataUrl,
      }));

    onSend(text.trim() || "(attached files)", attachments, html.trim());
    editorRef.current.commands.clearContent();
    setTextLen(0);
    setPendingFiles([]);
  }, [disabled, onSend, pendingFiles]);

  /* ── editor ───────────────────────────────── */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  const CustomMention = Mention.extend({
    addNodeView() {
      return ReactNodeViewRenderer(MentionNodeView);
    },
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, blockquote: false }),
      CustomMention.configure({
        HTMLAttributes: { class: "mention-chip" },
        suggestion: mentionSuggestion,
      }),
    ],
    editorProps: {
      attributes: { class: "tiptap-editor", "data-placeholder": placeholder },
    },
    onUpdate: ({ editor: ed }) => {
      setTextLen(ed.getText().length);
    },
  });

  editorRef.current = editor;

  /* ── keyboard ─────────────────────────────── */

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !isStreaming) {
        e.preventDefault();
        handleSend();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [editor, handleSend, isStreaming]);

  /* ── fill text from outside (chips) ─────────── */

  useEffect(() => {
    if (!fillText || !editor) return;
    editor.commands.setContent(fillText);
    editor.commands.focus("end");
    setTextLen(fillText.length);
    onFillTextConsumed?.();
  }, [fillText, editor, onFillTextConsumed]);

  /* ── paste (Ctrl+V images) ────────────────── */

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          const name = `pasted_${Date.now()}.png`;
          const reader = new FileReader();
          reader.onload = () => {
            setPendingFiles((prev) => [...prev, {
              id: nextFid(),
              file: new File([blob], name, { type: blob.type }),
              name,
              size: blob.size,
              type: blob.type,
              content: null,
              dataUrl: reader.result as string,
              uploading: false,
              error: null,
            }]);
          };
          reader.readAsDataURL(blob);
        }
      }
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [editor]);

  /* ── file attach ──────────────────────────── */

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const newPending: PendingFile[] = [];
    const arr = Array.from(files);

    for (const file of arr) {
      const pf: PendingFile = {
        id: nextFid(),
        file,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        content: null,
        dataUrl: null,
        uploading: false,
        error: null,
      };

      try {
        if (file.type === "text/plain" || file.name.endsWith(".txt") || file.name.endsWith(".md")) {
          pf.content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
          });
        } else if (file.type.startsWith("image/")) {
          pf.dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
        }
      } catch {
        pf.error = "read error";
      }

      newPending.push(pf);
    }

    setPendingFiles((prev) => [...prev, ...newPending]);
  }, []);

  const handleFileAttach = useCallback(() => fileInputRef.current?.click(), []);

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      processFiles(files);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [processFiles],
  );

  /* ── global file drop (outside tiptap) ───────── */

  useEffect(() => {
    const handler = (e: Event) => {
      const files = (e as CustomEvent<FileList>).detail;
      if (files?.length) processFiles(files);
    };
    window.addEventListener("global-files-drop", handler);
    return () => window.removeEventListener("global-files-drop", handler);
  }, [processFiles]);

  /* ── drag & drop (tiptap-local) ─────────────── */

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      el.classList.add("drag-over");
    };

    const onDragLeave = () => {
      el.classList.remove("drag-over");
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drag-over");
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      processFiles(files);
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [editor, processFiles]);

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((pf) => pf.id !== id));
  }, []);

  /* ── render ───────────────────────────────── */

  const hasText = textLen > 0;

  if (!editor) return null;

  return (
    <div className="composer">
      <div className="composer-box">
        {pendingFiles.length > 0 && (
          <div className="ca-grid">
            {pendingFiles.map((pf) => {
              const isImage = pf.type.startsWith("image/");
              const ext = pf.name.includes(".")
                ? pf.name.split(".").pop()!.toUpperCase().slice(0, 5)
                : "FILE";
              const lineCount = pf.content != null ? pf.content.split("\n").length : null;
              const errStyle = pf.error
                ? { borderColor: "var(--err-line)", background: "var(--err-soft)" }
                : undefined;

              if (isImage && pf.dataUrl) {
                return (
                  <div key={pf.id} className={`ca-card-img${pf.uploading ? " ca-card--up" : ""}`}>
                    <img src={pf.dataUrl} alt={pf.name} />
                    <button className="ca-x" onClick={() => removeFile(pf.id)} title="Remove">×</button>
                  </div>
                );
              }

              return (
                <div
                  key={pf.id}
                  className={`ca-card${pf.uploading ? " ca-card--up" : ""}${pf.error ? " ca-card--err" : ""}`}
                  style={errStyle}
                >
                  <div className="ca-name">{pf.name}</div>
                  <div className="ca-meta">
                    {pf.error ? pf.error : lineCount != null ? `${lineCount} lines` : fmtSize(pf.size)}
                  </div>
                  <div className="ca-badge">{ext}</div>
                  {pf.uploading
                    ? <span className="ca-spin">⟳</span>
                    : <button className="ca-x" onClick={() => removeFile(pf.id)} title="Remove">×</button>
                  }
                </div>
              );
            })}
          </div>
        )}

        <div className="tiptap-wrap">
          <EditorContent editor={editor} />
          {textLen === 0 && <div className="tiptap-ph">{placeholder}</div>}
        </div>

        <div className="composer-bar">
          <div className="composer-left">
            <button className="icon-btn" title="Attach files" onClick={handleFileAttach}><Plus /></button>
            <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFileSelected} />

            {(hasText || pendingFiles.length > 0) && (
              <span className="composer-token-count">
                {pendingFiles.length > 0 && `${pendingFiles.length} files · `}
                ~{Math.ceil(textLen / 3.5)} tokens
              </span>
            )}
          </div>

          <div className="composer-right">
            <ModelSelector
              models={models}
              model={model}
              onChange={onModelChange}
              thinkingEnabled={thinkingEnabled}
              onThinkingToggle={onThinkingToggle}
            />

            {isStreaming ? (
              <button className="send-btn stop-btn" onClick={onStop} title="Stop"><X /></button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={disabled || (!hasText && pendingFiles.length === 0)}
                title="Send"
              ><ArrowUp /></button>
            )}
          </div>
        </div>
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
