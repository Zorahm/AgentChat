/** Artifacts side panel — Render / Code tabs, per-artifact navigation. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X, ArrowClockwise, CaretDown, Copy, DownloadSimple, Eye, Code } from "@phosphor-icons/react";
import type { ChatMessage } from "../../types/chat";
import type { Artifact, LiveFile } from "../../types/artifact";
import { RENDERABLE_EXTS, BINARY_EXTS } from "../../types/artifact";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { API_BASE } from "../../utils/apiBase";
import { basename } from "../../utils/basename";
import { RenderView, CodeView } from "./ArtifactViews";
import { useTranslation } from "react-i18next";

type ViewTab = "render" | "code";

/* Minimal File System Access API shape — not in lib.dom.d.ts. Used for the
 * native "Save As" dialog (Chromium / WebView2). */
interface FsWritable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}
interface FsFileHandle {
  createWritable: () => Promise<FsWritable>;
}
type ShowSaveFilePicker = (opts?: { suggestedName?: string }) => Promise<FsFileHandle>;

function isRenderable(ext: string): boolean {
  return RENDERABLE_EXTS.has(ext);
}

function isCodeViewable(ext: string): boolean {
  return !BINARY_EXTS.has(ext);
}

function pickDefaultTab(ext: string): ViewTab {
  if (isRenderable(ext)) return "render";
  if (isCodeViewable(ext)) return "code";
  return "render";
}

interface Props {
  messages: ChatMessage[];
  liveFiles: LiveFile[];
  openFilePath?: string | null;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

function collectArtifacts(messages: ChatMessage[]): Artifact[] {
  const seen = new Set<string>();
  const result: Artifact[] = [];

  const push = (art: Artifact) => {
    const key = art.path ?? art.label ?? JSON.stringify(art);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(art);
  };

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const a of parseArtifacts(msg.content).artifacts) push(a);
  }

  return result;
}

/** Paths that were edited via edit_file after their liveFile was created. */
function editedPaths(messages: ChatMessage[]): Set<string> {
  const s = new Set<string>();
  for (const msg of messages) {
    for (const tc of msg.toolCalls ?? []) {
      if (tc.name === "edit_file" && tc.status === "success") {
        const p = String(tc.input?.path ?? "");
        if (p) s.add(p);
      }
    }
  }
  return s;
}

export function ArtifactsSidePanel({ messages, liveFiles, openFilePath, onClose, onResizeStart }: Props) {
  const { t } = useTranslation();
  const artifacts = collectArtifacts(messages);
  const artifactsRef = useRef<Artifact[]>([]);
  artifactsRef.current = artifacts;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [tab, setTab] = useState<ViewTab>("render");
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Navigate to the file indicated by openFilePath whenever it changes.
  useEffect(() => {
    if (!openFilePath || artifacts.length === 0) return;
    const idx = artifactsRef.current.findIndex((a) => a.path === openFilePath);
    if (idx >= 0) {
      setSelectedIdx(idx);
      setTab(pickDefaultTab(openFilePath.split(".").pop()?.toLowerCase() ?? ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFilePath]);

  // Auto-navigate to the newest artifact when the list grows (e.g. a new file
  // is written or edited). Skip on the initial mount — at that point we rely
  // on the openFilePath effect above to position correctly.
  const prevArtifactCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevArtifactCountRef.current === null) {
      prevArtifactCountRef.current = artifacts.length;
      return;
    }
    if (artifacts.length > prevArtifactCountRef.current) {
      const idx = artifacts.length - 1;
      setSelectedIdx(idx);
      const ext = artifactsRef.current[idx]?.path?.split(".").pop()?.toLowerCase() ?? "";
      setTab(pickDefaultTab(ext));
    }
    prevArtifactCountRef.current = artifacts.length;
  }, [artifacts.length]);

  const selected = artifacts[selectedIdx] ?? null;
  const activeLive = selected?.path
    ? liveFiles.find((f) => f.path === selected.path && !f.done)
    : undefined;
  const isWritingSelected = !!activeLive;

  // Paths touched by a completed edit_file — their liveFile content is stale.
  const edited = useMemo(() => editedPaths(messages), [messages]);

  const getContent = useCallback(
    (art: Artifact | null): string | null => {
      if (!art) return null;
      if (!art.path) return (art as Record<string, string>)["content"] ?? null;
      const lf = liveFiles.find((f) => f.path === art.path);
      // Still streaming — no content yet.
      if (lf && !lf.done) return null;
      // Done liveFile, but if the file was edited since writing, skip stale liveFile
      // content and fall through to the cache (which holds the post-edit bytes).
      if (lf && lf.done && !edited.has(art.path)) return lf.content;
      return cache[art.path] ?? null;
    },
    [liveFiles, cache, edited],
  );

  useEffect(() => {
    if (!selected?.path) return;
    const path = selected.path;
    if (liveFiles.some((f) => f.path === path && !f.done)) return;
    if (cache[path] !== undefined) return;
    if (loading.has(path)) return;

    setLoading((s) => new Set([...s, path]));
    fetch(`${API_BASE}/files/content?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((text) => setCache((c) => ({ ...c, [path]: text })))
      .catch(() => setCache((c) => ({ ...c, [path]: null })))
      .finally(() =>
        setLoading((s) => {
          const next = new Set(s);
          next.delete(path);
          return next;
        }),
      );
  }, [selected, liveFiles, cache, loading]);

  // When a live file finishes writing, drop its cached entry so the next
  // render re-fetches the freshly-written bytes from disk.
  const liveDoneKey = liveFiles
    .filter((f) => f.done)
    .map((f) => f.path)
    .join("|");
  useEffect(() => {
    if (!liveDoneKey) return;
    setCache((c) => {
      const next = { ...c };
      for (const p of liveDoneKey.split("|")) delete next[p];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDoneKey]);

  // When edit_file completes, evict the cache for those paths so the panel
  // re-fetches the updated bytes from disk automatically.
  const editDoneKey = [...edited].sort().join("|");
  useEffect(() => {
    if (!editDoneKey) return;
    setCache((c) => {
      const next = { ...c };
      for (const p of editDoneKey.split("|")) if (p) delete next[p];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDoneKey]);

  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  const refresh = useCallback(() => {
    if (!selected?.path) return;
    const path = selected.path;
    setCache((c) => {
      const next = { ...c };
      delete next[path];
      return next;
    });
  }, [selected]);

  const content = getContent(selected);
  const isLoading = !!(selected?.path && loading.has(selected.path));
  const copy = () => {
    if (content !== null) navigator.clipboard.writeText(content).catch(() => {});
    setDropOpen(false);
  };

  const download = async () => {
    if (!filePath || !fileName) return;
    const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;

    // Native "Save As" dialog when supported — call before any await to keep
    // the click's user activation. Cancelling the dialog aborts silently.
    if (picker) {
      let handle: FsFileHandle;
      try {
        handle = await picker({ suggestedName: fileName });
      } catch {
        return; // user cancelled
      }
      try {
        const res = await fetch(`${API_BASE}/files/serve?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) return;
        const blob = await res.blob();
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch {
        // best-effort
      }
      return;
    }

    // Fallback (no picker support): browser default download.
    try {
      const res = await fetch(`${API_BASE}/files/serve?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // best-effort
    }
  };

  const filePath = selected?.path ?? "";
  const fileName = filePath ? basename(filePath) : (selected?.label ?? "artifact");
  const ext = filePath.split(".").pop()?.toUpperCase() ?? "";
  const extLower = ext.toLowerCase();

  const canRender = isRenderable(extLower);
  const canCode = isCodeViewable(extLower);

  if (artifacts.length === 0) {
    return (
      <aside className="art-panel">
        <div className="art-resize-handle" onMouseDown={onResizeStart} />
        <div className="art-panel-placeholder">{t("artifacts.placeholder")}</div>
      </aside>
    );
  }

  return (
    <aside className="art-panel">
      <div className="art-resize-handle" onMouseDown={onResizeStart} />

      <div className="ap-head">
        <div className="ap-head-left">
          {canRender && (
            <button
              className={`ap-tab-btn${tab === "render" ? " active" : ""}`}
              onClick={() => setTab("render")}
              title={t("artifacts.preview")}
            >
              <Eye />
            </button>
          )}
          {canCode && (
            <button
              className={`ap-tab-btn${tab === "code" ? " active" : ""}`}
              onClick={() => setTab("code")}
              title={t("artifacts.code")}
            >
              <Code />
            </button>
          )}
          <span className="ap-head-name">
            {fileName}
            {ext && <span className="ap-head-ext"> · {ext}</span>}
          </span>
        </div>

        <div className="ap-head-right">
          <div className="ap-drop-wrap" ref={dropRef}>
            <div className="ap-split-btn">
              <button
                className="ap-split-btn__main"
                onClick={download}
                disabled={content === null}
                title={t("artifacts.download")}
              >
                <DownloadSimple size={14} />
                <span>{t("artifacts.download")}</span>
              </button>
              <button
                className="ap-split-btn__arrow"
                onClick={() => setDropOpen((o) => !o)}
                disabled={content === null}
                title={t("artifacts.more")}
              >
                <CaretDown size={10} />
              </button>
            </div>
            {dropOpen && (
              <div className="ap-drop-menu">
                <button className="ap-drop-item" onClick={copy}>
                  <Copy size={13} />
                  {t("artifacts.copy")}
                </button>
              </div>
            )}
          </div>
          <button className="ap-icon-btn" onClick={refresh} title={t("artifacts.refresh")}>
            <ArrowClockwise size={15} />
          </button>
          <button className="ap-icon-btn ap-icon-btn--close" onClick={onClose} title={t("artifacts.close")}>
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="art-content">
        {isWritingSelected && (
          <div className="art-writing-placeholder">
            <div className="art-writing-dot" />
            {t("artifacts.writing")}
          </div>
        )}
        {!isWritingSelected && selected && tab === "render" && (
          <RenderView artifact={selected} content={content} loading={isLoading} />
        )}
        {!isWritingSelected && selected && tab === "code" && (
          <CodeView artifact={selected} content={content} loading={isLoading} />
        )}
      </div>
    </aside>
  );
}
