/** Artifacts side panel — Render / Code tabs, per-artifact navigation. */

import { useState, useEffect, useCallback, useRef } from "react";
import { X, ArrowsClockwise, Copy, Eye, Code } from "@phosphor-icons/react";
import type { ChatMessage } from "../../types/chat";
import type { Artifact, LiveFile } from "../../types/artifact";
import { RENDERABLE_EXTS, BINARY_EXTS } from "../../types/artifact";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { API_BASE } from "../../utils/apiBase";
import { RenderView, CodeView } from "./ArtifactViews";

type ViewTab = "render" | "code";

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

function collectArtifacts(messages: ChatMessage[], liveFiles: LiveFile[]): Artifact[] {
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
    // Inline <artifact /> markers — legacy path
    for (const a of parseArtifacts(msg.content).artifacts) push(a);
    // <file> tag tool calls — the file the model wrote becomes openable
    for (const tc of msg.toolCalls ?? []) {
      if (tc.name !== "write_file") continue;
      const path = String(tc.input?.path ?? "");
      if (!path) continue;
      const label = path.split(/[/\\]/).pop() ?? path;
      push({ type: "file", path, label });
    }
  }
  // In-flight writes that haven't yet been committed to the message
  for (const lf of liveFiles) {
    if (!lf.path) continue;
    const label = lf.path.split(/[/\\]/).pop() ?? lf.path;
    push({ type: "file", path: lf.path, label });
  }

  return result;
}

export function ArtifactsSidePanel({ messages, liveFiles, openFilePath, onClose, onResizeStart }: Props) {
  const artifacts = collectArtifacts(messages, liveFiles);
  const artifactsRef = useRef<Artifact[]>([]);
  artifactsRef.current = artifacts;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [tab, setTab] = useState<ViewTab>("render");
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Single effect handles both cases: openFilePath change and artifacts change (e.g. lazy load).
  // openFilePath takes priority; falls back to last artifact when not found.
  useEffect(() => {
    if (artifacts.length === 0) return;
    if (openFilePath) {
      const idx = artifactsRef.current.findIndex((a) => a.path === openFilePath);
      if (idx >= 0) {
        setSelectedIdx(idx);
        const ext = openFilePath.split(".").pop()?.toLowerCase() ?? "";
        setTab(pickDefaultTab(ext));
        return;
      }
    }
    const idx = artifacts.length - 1;
    setSelectedIdx(idx);
    const ext = artifacts[idx]?.path?.split(".").pop()?.toLowerCase() ?? "";
    setTab(pickDefaultTab(ext));
  }, [openFilePath, artifacts.length]);

  const selected = artifacts[selectedIdx] ?? null;
  const activeLive = selected?.path
    ? liveFiles.find((f) => f.path === selected.path && !f.done)
    : undefined;
  const isWritingSelected = !!activeLive;

  const getContent = useCallback(
    (art: Artifact | null): string | null => {
      if (!art) return null;
      if (!art.path) return (art as Record<string, string>)["content"] ?? null;
      // While a file is still being streamed in, deliberately surface NO content
      // so the panel stays light and the user can close it without fighting
      // re-renders. The inline preview under the tool call shows the live stream.
      const lf = liveFiles.find((f) => f.path === art.path);
      if (lf && !lf.done) return null;
      if (lf && lf.done) return lf.content;
      return cache[art.path] ?? null;
    },
    [liveFiles, cache],
  );

  useEffect(() => {
    if (!selected?.path) return;
    const path = selected.path;
    // Don't fetch from disk while the write is still in flight — the file
    // either doesn't exist yet or holds stale bytes.
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

  // When a live file finishes writing, drop its cached entry (if any) so the
  // next render re-fetches the freshly-written bytes from disk.
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
  };

  const filePath = selected?.path ?? "";
  const fileName = filePath.split("/").pop() ?? selected?.label ?? "artifact";
  const ext = filePath.split(".").pop()?.toUpperCase() ?? "";
  const extLower = ext.toLowerCase();

  const canRender = isRenderable(extLower);
  const canCode = isCodeViewable(extLower);

  if (artifacts.length === 0) {
    return (
      <aside className="art-panel">
        <div className="art-resize-handle" onMouseDown={onResizeStart} />
        <div className="art-panel-placeholder">Artifacts will appear here</div>
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
              title="Preview"
            >
              <Eye />
            </button>
          )}
          {canCode && (
            <button
              className={`ap-tab-btn${tab === "code" ? " active" : ""}`}
              onClick={() => setTab("code")}
              title="Code"
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
          <button
            className="ap-copy-btn"
            onClick={copy}
            disabled={content === null}
            title="Copy to clipboard"
          >
            <Copy size={14} />
            <span>Copy</span>
          </button>
          <button className="ap-icon-btn" onClick={refresh} title="Refresh">
            <ArrowsClockwise size={15} />
          </button>
          <button className="ap-icon-btn ap-icon-btn--close" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
      </div>

      {artifacts.length > 1 && (
        <div className="art-file-tabs">
          {artifacts.map((a, i) => {
            const name = a.path?.split("/").pop() ?? a.label ?? `artifact ${i + 1}`;
            return (
              <div
                key={i}
                className={`art-file-tab${i === selectedIdx ? " active" : ""}`}
                onClick={() => {
                  setSelectedIdx(i);
                  const e = a.path?.split(".").pop()?.toLowerCase() ?? "";
                  setTab(pickDefaultTab(e));
                }}
                title={a.path}
              >
                {name}
              </div>
            );
          })}
        </div>
      )}

      <div className="art-content">
        {isWritingSelected && (
          <div className="art-writing-placeholder">
            <div className="art-writing-dot" />
            Файл записывается…
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
