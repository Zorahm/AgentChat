/** Chat input — Composer with @mentions + file attachments. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, X, Plus, Paperclip, Image as ImageIcon, Camera } from "@phosphor-icons/react";
import { EditorContent, useEditor, ReactNodeViewRenderer } from "@tiptap/react";
import { mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { ModelItem } from "./ChatView";
import { ModelSelector } from "./ModelSelector";
import type { Agent } from "../../types/agent";
import { BottomSheet } from "../BottomSheet";
import { useIsMobile } from "../../hooks/useIsMobile";
import { McpMenuSection } from "./MCPChip";
import { WebSearchMenuSection } from "./WebSearchMenuSection";
import { ResearchMenuSection } from "./ResearchMenuSection";
import { useFileDrop } from "../../hooks/useFileDrop";
import type { AttachmentInfo } from "../../types/chat";
import { buildMentionSuggestion, extractText, mentionDisplay } from "../../utils/mentions";
import { MentionNodeView } from "./MentionNodeView";
import { useTranslation } from "react-i18next";
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
  effortLevel: string | null;
  onEffortChange: (v: string | null) => void;
  placeholder?: string;
  fillText?: string;
  onFillTextConsumed?: () => void;
  dirSlug?: string | null;
  mcpEnabled?: string[];
  onToggleMcpServer?: (serverId: string) => void;
  webSearchEnabled?: boolean;
  webSearchMode?: string;
  onWebSearchChange?: (enabled: boolean, mode?: string) => void;
  researchEnabled?: boolean;
  onResearchChange?: (enabled: boolean) => void;
  agents?: Agent[];
  agentId?: string;
  onAgentChange?: (agentId: string) => void;
  /** When true (e.g. a file is dragged anywhere over a project), show the drop
   *  overlay even before the cursor reaches the composer. */
  externalDragActive?: boolean;
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

/** Characters above which pasted/typed text becomes a .txt file attachment. */
const LARGE_TEXT_CHARS = 20_000;

export function ChatInput({
  onSend, onStop, disabled, isStreaming,
  models, model, onModelChange, thinkingEnabled, onThinkingToggle,
  effortLevel, onEffortChange,
  placeholder,
  fillText, onFillTextConsumed,
  dirSlug,
  mcpEnabled, onToggleMcpServer,
  webSearchEnabled, webSearchMode, onWebSearchChange,
  researchEnabled, onResearchChange, externalDragActive,
  agents, agentId, onAgentChange,
}: ChatInputProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [textLen, setTextLen] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusUp, setPlusUp] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  // Always-current mirror of pendingFiles, so async handlers (handleSend after
  // awaiting uploads, removeFile) read the latest paths instead of a stale closure.
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pendingFiles;
  // In-flight immediate-uploads, keyed by pending-file id (value = the upload
  // promise so handleSend can await them). Removal-during-upload is tracked so
  // the just-written file gets wiped instead of lingering in uploads/.
  const uploadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const removedDuringUploadRef = useRef<Set<string>>(new Set());
  // Authoritative record of resolved upload paths, keyed by id. handleSend reads
  // this rather than React state so it can't race the post-upload re-render.
  const resolvedRef = useRef<Map<string, { path: string; content?: string }>>(new Map());
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
    const rawText = extractText(editorRef.current.getJSON());
    if ((!rawText.trim() && pendingRef.current.length === 0) || disabled) return;

    // Files upload the moment they're added, so by send-time they usually have
    // a path already. Wait out any still-in-flight upload so every attachment
    // carries its server path rather than racing the request.
    if (uploadsRef.current.size > 0) {
      try { await Promise.all([...uploadsRef.current.values()]); } catch { /* keep going */ }
    }

    // ── Auto-convert large text to a .txt file attachment ─────────────────
    // content=null ensures the backend references it by path (read_file),
    // rather than inlining it into the model's context.
    let sendText = rawText;
    let sendHtml = html;
    // Fold in any paths resolved by the immediate upload — authoritative even if
    // the post-upload re-render hasn't flushed into pendingRef yet.
    let basePending = pendingRef.current.map((pf) => {
      if (pf.uploadedPath) return pf;
      const r = resolvedRef.current.get(pf.id);
      if (!r) return pf;
      return {
        ...pf,
        uploading: false,
        uploadedPath: r.path,
        content:
          pf.content === null && pf.type === "text/plain" ? null : r.content ?? pf.content,
      };
    });
    if (rawText.trim().length > LARGE_TEXT_CHARS) {
      const body = rawText.trim();
      const fileName = `text_${Date.now()}.txt`;
      const file = new File([body], fileName, { type: "text/plain" });
      basePending = [{
        id: nextFid(), file, name: fileName, size: file.size,
        type: "text/plain", content: null, dataUrl: null, uploading: false, error: null,
      }, ...basePending];
      sendText = "";
      sendHtml = "";
    }
    // ── end auto-convert ───────────────────────────────────────────────────

    // Upload ALL files to disk so every attachment has a server path.
    const needUpload = basePending.filter(
      (pf) => !pf.uploading && !pf.uploadedPath
    );
    const finalFiles = [...basePending];

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
          // The response preserves the order of `needUpload` (the order we
          // appended to FormData), so pair by index. Matching by name was
          // unreliable: the backend sanitises filenames (_safe_filename), and
          // the old `&& pf.uploading` guard never matched — finalFiles holds
          // the pre-upload objects whose `uploading` flag is still false, so
          // uploadedPath was never set and the model saw "path: None".
          const uploaded: Array<{ name: string; path: string; size: number; mime_type: string; content?: string }> = await r.json();
          uploaded.forEach((up, i) => {
            const src = needUpload[i];
            if (!src) return;
            const idx = finalFiles.findIndex((pf) => pf.id === src.id);
            if (idx < 0) return;
            const cur = finalFiles[idx]!;
            finalFiles[idx] = {
              ...cur,
              content: (cur.content === null && cur.type === "text/plain")
                ? null
                : (up.content ?? cur.content),
              uploading: false,
              uploadedPath: up.path,
            };
          });
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

    onSend(sendText.trim() || "(attached files)", attachments, sendHtml.trim() || undefined);
    editorRef.current.commands.clearContent();
    setTextLen(0);
    setPendingFiles([]);
    resolvedRef.current.clear();
  }, [disabled, onSend, dirSlug]);

  /* ── editor ───────────────────────────────── */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  const CustomMention = Mention.extend({
    addNodeView() {
      return ReactNodeViewRenderer(MentionNodeView);
    },
    // getHTML() (used for the persisted/sent displayHtml) bypasses the React
    // NodeView, so without this the chip serialized as the raw "@skill:NAME"
    // label. Mirror the NodeView: strip the "type:" prefix and capitalize.
    renderHTML({ node, HTMLAttributes }) {
      const label = String(node.attrs.label ?? node.attrs.id ?? "");
      const { type, text } = mentionDisplay(label);
      return [
        "span",
        mergeAttributes({ class: `mention-chip--${type}` }, HTMLAttributes),
        `@${text}`,
      ];
    },
  });

  // Ref pattern keeps the closure current without re-creating the editor on each render.
  const handlePasteRef = useRef<(view: unknown, event: ClipboardEvent) => boolean>(() => false);
  handlePasteRef.current = (_view, event) => {
    const plainText = event.clipboardData?.getData("text/plain") ?? "";
    if (plainText.length > LARGE_TEXT_CHARS) {
      const fileName = `pasted_${Date.now()}.txt`;
      const file = new File([plainText], fileName, { type: "text/plain" });
      setPendingFiles((prev) => [...prev, {
        id: nextFid(), file, name: fileName, size: file.size,
        type: "text/plain", content: null, dataUrl: null, uploading: false, error: null,
      }]);
      return true; // tells ProseMirror: handled, don't insert
    }
    const items = event.clipboardData?.items;
    if (items) {
      let handled = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item?.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (!blob) continue;
          const name = `pasted_${Date.now()}.png`;
          const reader = new FileReader();
          reader.onload = () => {
            setPendingFiles((prev) => [...prev, {
              id: nextFid(),
              file: new File([blob], name, { type: blob.type }),
              name, size: blob.size, type: blob.type,
              content: null, dataUrl: reader.result as string,
              uploading: false, error: null,
            }]);
          };
          reader.readAsDataURL(blob);
          handled = true;
        }
      }
      if (handled) return true;
    }
    return false;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, blockquote: false }),
      CustomMention.configure({
        HTMLAttributes: { class: "mention-chip" },
        suggestion: mentionSuggestion,
      }),
    ],
    editorProps: {
      attributes: { class: "composer-editor", "data-placeholder": placeholder ?? t("chat.placeholder") },
      handlePaste: (view, event) => handlePasteRef.current(view, event),
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

  /* ── mobile: auto-scroll editor to bottom so new text stays visible ──── */

  useEffect(() => {
    if (!editor || !isMobile) return;
    const el = editor.view.dom;
    if (el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
    }
  }, [textLen, isMobile, editor]);

  /* ── focus from the "focus input" keyboard shortcut ─────────── */

  useEffect(() => {
    if (!editor) return;
    const focusComposer = () => editor.commands.focus("end");
    window.addEventListener("focus-composer", focusComposer);
    return () => window.removeEventListener("focus-composer", focusComposer);
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

  const togglePlus = useCallback(() => {
    setPlusOpen((v) => {
      if (!v && plusRef.current) {
        const rect = plusRef.current.getBoundingClientRect();
        // Open downward when there's more room below (composer near the top of
        // the projects page); upward in chat where the composer sits at the bottom.
        setPlusUp(rect.top > window.innerHeight - rect.bottom);
      }
      return !v;
    });
  }, []);

  const openFilePicker = useCallback(() => {
    setPlusOpen(false);
    fileInputRef.current?.click();
  }, []);

  const openCamera = useCallback(() => {
    setPlusOpen(false);
    cameraInputRef.current?.click();
  }, []);

  const openPhotos = useCallback(() => {
    setPlusOpen(false);
    photoInputRef.current?.click();
  }, []);

  useEffect(() => {
    if (!plusOpen || isMobile) return;
    const onDoc = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [plusOpen, isMobile]);

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      processFiles(files);
      e.target.value = "";
    },
    [processFiles],
  );

  /* ── global file drop (outside composer) ───────── */

  useEffect(() => {
    const handler = (e: Event) => {
      const files = (e as CustomEvent<FileList>).detail;
      if (files?.length) processFiles(files);
    };
    window.addEventListener("global-files-drop", handler);
    return () => window.removeEventListener("global-files-drop", handler);
  }, [processFiles]);

  /* ── drag & drop onto the composer ─────────────── */
  // Drop files anywhere over the composer box, with a Claude-style overlay.
  // `externalDragActive` lights it up as soon as a file enters the window.
  const { dragging, handlers: dropHandlers } = useFileDrop(processFiles);
  const showDrop = dragging || !!externalDragActive;

  /* ── immediate upload lifecycle ───────────────── */

  const deleteFromDisk = useCallback((path: string) => {
    const form = new FormData();
    form.append("path", path);
    if (dirSlug) form.append("chat_dir_slug", dirSlug);
    return fetch(`${API_BASE}/files/delete`, { method: "POST", body: form }).catch(() => {});
  }, [dirSlug]);

  // Upload a batch to the chat sandbox right away and record each server path.
  const uploadFiles = useCallback(async (items: PendingFile[]) => {
    if (items.length === 0) return;
    const ids = new Set(items.map((i) => i.id));
    setPendingFiles((prev) =>
      prev.map((pf) => (ids.has(pf.id) ? { ...pf, uploading: true } : pf)),
    );

    const form = new FormData();
    for (const it of items) form.append("files", it.file);
    if (dirSlug) form.append("chat_dir_slug", dirSlug);

    const run = (async () => {
      try {
        const r = await fetch(`${API_BASE}/files/upload`, { method: "POST", body: form });
        if (!r.ok) throw new Error("upload failed");
        // Response preserves FormData order — pair by index (filenames get
        // sanitised server-side so name matching is unreliable).
        const uploaded: Array<{ name: string; path: string; size: number; mime_type: string; content?: string }> = await r.json();
        uploaded.forEach((up, i) => {
          const src = items[i];
          if (!src) return;
          // Removed mid-upload → wipe the file we just wrote, don't restore it.
          if (removedDuringUploadRef.current.has(src.id)) {
            removedDuringUploadRef.current.delete(src.id);
            void deleteFromDisk(up.path);
            return;
          }
          resolvedRef.current.set(src.id, { path: up.path, content: up.content });
          setPendingFiles((prev) =>
            prev.map((pf) =>
              pf.id === src.id
                ? {
                    ...pf,
                    uploading: false,
                    uploadedPath: up.path,
                    content:
                      pf.content === null && pf.type === "text/plain"
                        ? null
                        : up.content ?? pf.content,
                  }
                : pf,
            ),
          );
        });
      } catch {
        // Leave the file pathless; handleSend retries the upload, and the model
        // can still receive it by inline content / data URL.
        setPendingFiles((prev) =>
          prev.map((pf) => (ids.has(pf.id) ? { ...pf, uploading: false } : pf)),
        );
      }
    })();

    for (const it of items) uploadsRef.current.set(it.id, run);
    await run;
    for (const it of items) uploadsRef.current.delete(it.id);
  }, [dirSlug, deleteFromDisk]);

  // Auto-upload every freshly added file once, regardless of entry point
  // (drop, paste, picker, large-text conversion).
  useEffect(() => {
    const toUpload = pendingFiles.filter(
      (pf) => !pf.uploadedPath && !pf.uploading && !pf.error && !uploadsRef.current.has(pf.id),
    );
    if (toUpload.length > 0) void uploadFiles(toUpload);
  }, [pendingFiles, uploadFiles]);

  const removeFile = useCallback((id: string) => {
    const pf = pendingRef.current.find((p) => p.id === id);
    setPendingFiles((prev) => prev.filter((p) => p.id !== id));
    // Path may live in resolvedRef before the re-render lands it on pf.
    const path = pf?.uploadedPath ?? resolvedRef.current.get(id)?.path;
    resolvedRef.current.delete(id);
    if (path) {
      void deleteFromDisk(path); // already on disk — delete now
    } else if (uploadsRef.current.has(id)) {
      removedDuringUploadRef.current.add(id); // in flight — delete on completion
    }
  }, [deleteFromDisk]);

  /* ── render ───────────────────────────────── */

  const hasText = textLen > 0;

  if (!editor) return null;

  return (
    <div className="composer">
      <div
        className={`composer-box${showDrop ? " composer-box--dragging" : ""}`}
        {...dropHandlers}
      >
        {showDrop && (
          <div className="composer-drop" aria-hidden>
            <ImageIcon size={22} weight="light" />
            <span>{t("chat.dropToAttach")}</span>
          </div>
        )}
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
                    <button className="ca-x" onClick={() => removeFile(pf.id)} title={t("chat.remove")}>×</button>
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
                      : <button className="ca-x" onClick={() => removeFile(pf.id)} title={t("chat.remove")}>×</button>
                  }
                </div>
              );
            })}
          </div>
        )}

        <div className="composer-wrap">
          <EditorContent editor={editor} />
          {textLen === 0 && <div className="composer-ph">{placeholder ?? t("chat.placeholder")}</div>}
        </div>

        <div className="composer-bar">
          <div className="composer-left">
            <div className="composer-plus" ref={plusRef}>
              <button className="icon-btn" title={t("chat.add")} onClick={togglePlus}><Plus /></button>
              {plusOpen && isMobile && (
                <BottomSheet open={plusOpen} onClose={() => setPlusOpen(false)}>
                  <div className="cpm-sheet cpm-sheet--claude">
                    <div className="cpm-sheet-head">
                      <span className="cpm-sheet-title">{t("chat.addToChat")}</span>
                      <button
                        className="cpm-sheet-close"
                        onClick={() => setPlusOpen(false)}
                        aria-label={t("common.close")}
                      >
                        <X />
                      </button>
                    </div>

                    <div className="cpm-quick-row">
                      <button className="cpm-quick" onClick={openCamera}>
                        <span className="cpm-quick-ic"><Camera weight="duotone" /></span>
                        <span className="cpm-quick-label">{t("chat.quickCamera")}</span>
                      </button>
                      <button className="cpm-quick" onClick={openPhotos}>
                        <span className="cpm-quick-ic"><ImageIcon weight="duotone" /></span>
                        <span className="cpm-quick-label">{t("chat.quickPhotos")}</span>
                      </button>
                      <button className="cpm-quick" onClick={openFilePicker}>
                        <span className="cpm-quick-ic"><Paperclip weight="duotone" /></span>
                        <span className="cpm-quick-label">{t("chat.quickFiles")}</span>
                      </button>
                    </div>

                    <div className="cpm-list">
                      {onResearchChange && (
                        <ResearchMenuSection
                          enabled={researchEnabled ?? false}
                          onChange={onResearchChange}
                        />
                      )}
                      {onWebSearchChange && (
                        <WebSearchMenuSection
                          enabled={webSearchEnabled ?? false}
                          mode={webSearchMode ?? "auto"}
                          onChange={onWebSearchChange}
                        />
                      )}
                      {onToggleMcpServer && (
                        <McpMenuSection
                          enabledIds={mcpEnabled ?? []}
                          onToggle={onToggleMcpServer}
                        />
                      )}
                    </div>
                  </div>
                </BottomSheet>
              )}
              {plusOpen && !isMobile && (
                <div className={`composer-plus-menu${plusUp ? "" : " composer-plus-menu--down"}`}>
                  <button className="cpm-item" onClick={openFilePicker}>
                    <Paperclip /> <span>{t("chat.attachFiles")}</span>
                  </button>
                  {onToggleMcpServer && (
                    <McpMenuSection
                      enabledIds={mcpEnabled ?? []}
                      onToggle={onToggleMcpServer}
                    />
                  )}
                  {onWebSearchChange && (
                    <WebSearchMenuSection
                      enabled={webSearchEnabled ?? false}
                      mode={webSearchMode ?? "auto"}
                      onChange={onWebSearchChange}
                    />
                  )}
                  {onResearchChange && (
                    <ResearchMenuSection
                      enabled={researchEnabled ?? false}
                      onChange={onResearchChange}
                    />
                  )}
                </div>
              )}
            </div>
            <ModelSelector
              models={models}
              model={model}
              onChange={onModelChange}
              thinkingEnabled={thinkingEnabled}
              onThinkingToggle={onThinkingToggle}
              effortLevel={effortLevel}
              onEffortChange={onEffortChange}
              agents={agents}
              agentId={agentId}
              onAgentChange={onAgentChange}
            />
            <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFileSelected} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFileSelected} />
            <input ref={photoInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileSelected} />

            {(hasText || pendingFiles.length > 0) && (
              <span className="composer-token-count">
                {pendingFiles.length > 0 && `${pendingFiles.length} ${t("chat.files", { count: pendingFiles.length })} · `}
                ~{Math.ceil(textLen / 3.5)} tokens
              </span>
            )}
          </div>

          <div className="composer-right">
            {isStreaming ? (
              <button className="send-btn stop-btn" onClick={onStop} title={t("chat.stop")}><X /></button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={disabled || (!hasText && pendingFiles.length === 0)}
                title={t("chat.send")}
              ><ArrowUp /></button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-disclaimer">{t("chat.disclaimer")}</p>
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
