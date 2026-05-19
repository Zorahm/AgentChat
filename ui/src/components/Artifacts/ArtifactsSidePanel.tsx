/** Artifacts side panel — Render / Code tabs, per-artifact navigation. */

import { useState, useEffect, useCallback, useRef } from "react";
import { X, ArrowsClockwise, Copy, Download } from "@phosphor-icons/react";
import type { ChatMessage } from "../../types/chat";
import type { Artifact, LiveFile } from "../../types/artifact";
import { RENDERABLE_EXTS, BINARY_EXTS } from "../../types/artifact";
import { parseArtifacts } from "../../utils/parseArtifacts";
import { API_BASE } from "../../utils/apiBase";
import { fileExtIcon } from "../../utils/toolIcons";
import { RenderView, CodeView } from "./ArtifactViews";

type ViewTab = "render" | "code";

function isRenderable(ext: string): boolean {
  return RENDERABLE_EXTS.has(ext);
}

function isCodeViewable(ext: string): boolean {
  // Binary formats have no useful textual source — hide the Code tab.
  return !BINARY_EXTS.has(ext);
}

function pickDefaultTab(ext: string): ViewTab {
  if (isRenderable(ext)) return "render";
  if (isCodeViewable(ext)) return "code";
  return "render"; // binary, non-renderable — fall back to render slot (shows download hint)
}

interface Props {
  messages: ChatMessage[];
  liveFiles: LiveFile[];
  openFilePath?: string | null;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

function collectArtifacts(messages: ChatMessage[]): Artifact[] {
  // Only files explicitly tagged with <artifact /> count. Intermediate scripts,
  // generator helpers, and other write_file output without the tag are NOT
  // surfaced here — that's the model's contract per the system prompt.
  const seen = new Set<string>();
  const result: Artifact[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const a of parseArtifacts(msg.content).artifacts) {
      const key = a.path ?? a.label ?? JSON.stringify(a);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(a);
    }
  }
  return result;
}

export function ArtifactsSidePanel({ messages, liveFiles, openFilePath, onClose, onResizeStart }: Props) {
  const artifacts = collectArtifacts(messages);
  const artifactsRef = useRef<Artifact[]>([]);
  artifactsRef.current = artifacts;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [tab, setTab] = useState<ViewTab>("render");
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (artifacts.length === 0) return;
    const idx = artifacts.length - 1;
    setSelectedIdx(idx);
    const ext = artifacts[idx]?.path?.split(".").pop()?.toLowerCase() ?? "";
    setTab(pickDefaultTab(ext));
  }, [artifacts.length]);

  // Select artifact by file path when "Open" is clicked in chat.
  // Uses ref to avoid re-running on every render (artifacts is a new reference each render).
  useEffect(() => {
    if (!openFilePath) return;
    const idx = artifactsRef.current.findIndex((a) => a.path === openFilePath);
    if (idx >= 0) {
      setSelectedIdx(idx);
      const ext = openFilePath.split(".").pop()?.toLowerCase() ?? "";
      setTab(pickDefaultTab(ext));
    }
  }, [openFilePath]);

  const selected = artifacts[selectedIdx] ?? null;

  const getContent = useCallback(
    (art: Artifact | null): string | null => {
      if (!art) return null;
      if (!art.path) return (art as Record<string, string>)["content"] ?? null;
      const lf = liveFiles.find((f) => f.path === art.path);
      if (lf) return lf.content;
      return cache[art.path] ?? null;
    },
    [liveFiles, cache],
  );

  useEffect(() => {
    if (!selected?.path) return;
    const path = selected.path;
    if (liveFiles.some((f) => f.path === path)) return;
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

  const download = () => {
    if (content === null || !selected) return;
    const name = selected.path?.split("/").pop() ?? "artifact";
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filePath = selected?.path ?? "";
  const fileName = filePath.split("/").pop() ?? selected?.label ?? "artifact";
  const ext = filePath.split(".").pop()?.toUpperCase() ?? "";
  const sizeLabel = content
    ? content.length > 1024
      ? (content.length / 1024).toFixed(1) + " KB"
      : content.length + " B"
    : "—";

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
                  const ext = a.path?.split(".").pop()?.toLowerCase() ?? "";
                  setTab(pickDefaultTab(ext));
                }}
                title={a.path}
              >
                {name}
              </div>
            );
          })}
        </div>
      )}

      <div className="ap-head">
        <div className="ap-title">
          <span className="ap-title-ic">{ext ? fileExtIcon(ext.toLowerCase()) : fileExtIcon("")}</span>
          <div>
            <span>{fileName}</span>
            <small>{filePath}</small>
          </div>
        </div>
        <button className="ap-close" onClick={onClose}><X /></button>
      </div>

      <div className="art-view-tabs">
        {isRenderable(ext.toLowerCase()) && (
          <button
            className={`art-view-tab${tab === "render" ? " active" : ""}`}
            onClick={() => setTab("render")}
          >
            Render
          </button>
        )}
        {isCodeViewable(ext.toLowerCase()) && (
          <button
            className={`art-view-tab${tab === "code" ? " active" : ""}`}
            onClick={() => setTab("code")}
          >
            Code
          </button>
        )}
        <button className="art-view-tab" disabled title="Coming later">
          Edit
        </button>
      </div>

      <div className="art-content">
        {selected && tab === "render" && (
          <RenderView artifact={selected} content={content} loading={isLoading} />
        )}
        {selected && tab === "code" && (
          <CodeView artifact={selected} content={content} loading={isLoading} />
        )}
      </div>

      <div className="ap-foot">
        <span className="ap-foot-meta">{ext.toLowerCase()} · {sizeLabel}</span>
        <div className="ap-foot-actions">
          <button onClick={refresh}><ArrowsClockwise /> Обновить</button>
          <button onClick={copy} disabled={content === null}><Copy /> Копировать</button>
          <button onClick={download} disabled={content === null}><Download /> Скачать</button>
        </div>
      </div>
    </aside>
  );
}
