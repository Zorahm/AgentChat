/** Artifacts side panel — Render / Code tabs for the file the user opened.
 *
 * Single source of truth: `openFilePath`. The panel shows exactly that path and
 * keeps no internal selection state, so it can't drift away from what the user
 * opened (the old `selectedIdx` + "jump to newest" effects competed with the
 * user's clicks — that's gone). Following an actively-writing file is handled
 * upstream in App, which updates `openFilePath`; here we stay a pure view. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X, ArrowClockwise, CaretDown, Copy, DownloadSimple, Eye, Code, Sparkle } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { ChatMessage } from "../../types/chat";
import type { Artifact, LiveFile } from "../../types/artifact";
import { RENDERABLE_EXTS, BINARY_EXTS } from "../../types/artifact";
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
  openFilePath: string;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
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

  // The panel is a pure view of openFilePath — RenderView/CodeView only need
  // the path + a display label, so we synthesize the artifact directly instead
  // of hunting for it in a list (which is what let the selection drift before).
  const selected: Artifact = useMemo(
    () => ({ type: "file", path: openFilePath, label: basename(openFilePath) }),
    [openFilePath],
  );

  const [tab, setTab] = useState<ViewTab>(() =>
    pickDefaultTab(openFilePath.split(".").pop()?.toLowerCase() ?? ""),
  );
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Default tab follows the opened file's type whenever the path changes.
  useEffect(() => {
    setTab(pickDefaultTab(openFilePath.split(".").pop()?.toLowerCase() ?? ""));
  }, [openFilePath]);

  const activeLive = liveFiles.find((f) => f.path === openFilePath && !f.done);
  const isWritingSelected = !!activeLive;

  // Paths touched by a completed edit_file — their liveFile content is stale.
  const edited = useMemo(() => editedPaths(messages), [messages]);

  const getContent = useCallback(
    (path: string): string | null => {
      const lf = liveFiles.find((f) => f.path === path);
      // Still streaming — no content yet.
      if (lf && !lf.done) return null;
      // Done liveFile, but if the file was edited since writing, skip stale
      // liveFile content and fall through to the cache (post-edit bytes).
      if (lf && lf.done && !edited.has(path)) return lf.content;
      return cache[path] ?? null;
    },
    [liveFiles, cache, edited],
  );

  useEffect(() => {
    const path = openFilePath;
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
  }, [openFilePath, liveFiles, cache, loading]);

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

  // ── Install-skill action (only when the opened file is a SKILL.md) ──────
  const [installState, setInstallState] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [installErr, setInstallErr] = useState("");

  // Reset the install affordance whenever a different file is opened.
  useEffect(() => {
    setInstallState("idle");
    setInstallErr("");
  }, [openFilePath]);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  const refresh = useCallback(() => {
    setCache((c) => {
      const next = { ...c };
      delete next[openFilePath];
      return next;
    });
  }, [openFilePath]);

  const filePath = openFilePath;
  const fileName = basename(filePath);
  const ext = filePath.split(".").pop()?.toUpperCase() ?? "";
  const extLower = ext.toLowerCase();
  const isSkillMd = fileName.toLowerCase() === "skill.md";
  const isSkillArchive = extLower === "skill" || extLower === "zip";
  const canInstall = isSkillMd || isSkillArchive;

  const installSkill = async () => {
    if (installState === "installing" || installState === "done") return;
    setInstallState("installing");
    setInstallErr("");
    try {
      const res = await fetch(`${API_BASE}/skills/install-local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { detail?: string }).detail ?? `HTTP ${res.status}`);
      }
      setInstallState("done");
      // Let the Skills tab / manifest refresh if it's listening.
      window.dispatchEvent(new CustomEvent("skills-changed"));
    } catch (e) {
      setInstallState("error");
      setInstallErr(e instanceof Error ? e.message : "");
    }
  };

  const installLabel =
    installState === "installing" ? t("skills.installing")
    : installState === "done" ? t("skills.skillInstalled")
    : installState === "error" ? t("skills.installFailed")
    : t("skills.installSkill");

  const canRender = isRenderable(extLower);
  const canCode = isCodeViewable(extLower);

  const content = getContent(openFilePath);
  const isLoading = loading.has(openFilePath);

  const copy = () => {
    if (content !== null) navigator.clipboard.writeText(content).catch(() => {});
    setDropOpen(false);
  };

  // Download pulls raw bytes from /files/serve — independent of `content` (the
  // *text* used by the Render/Code tabs). Gating download on `content` was the
  // "opens but can't download" bug: binaries, text-fetch failures, and the
  // brief cache-eviction window all leave `content` null while the file is
  // perfectly downloadable. Only block mid-write (partial bytes on disk).
  const download = async () => {
    if (!filePath) return;
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

  if (!openFilePath) return null;

  return (
    <aside className="art-panel">
      <div className="art-resize-handle" onMouseDown={onResizeStart} />

      <div className="ap-head">
        <div className="ap-head-left">
          {canRender && canCode && (
            <SegmentedControl
              value={tab}
              onChange={(v) => setTab(v as ViewTab)}
              label={t("artifacts.viewMode")}
              size="sm"
            >
              <SegmentedControlItem
                value="render"
                label={t("artifacts.preview")}
                icon={<Eye size={14} />}
                isLabelHidden
              />
              <SegmentedControlItem
                value="code"
                label={t("artifacts.code")}
                icon={<Code size={14} />}
                isLabelHidden
              />
            </SegmentedControl>
          )}
          {canRender && !canCode && (
            <SegmentedControl
              value={tab}
              onChange={(v) => setTab(v as ViewTab)}
              label={t("artifacts.viewMode")}
              size="sm"
            >
              <SegmentedControlItem
                value="render"
                label={t("artifacts.preview")}
                icon={<Eye size={14} />}
                isLabelHidden
              />
            </SegmentedControl>
          )}
          <span className="ap-head-name">
            {fileName}
            {ext && <span className="ap-head-ext"> · {ext}</span>}
          </span>
        </div>

        <div className="ap-head-right">
          {canInstall && (
            <Button
              label={installLabel}
              icon={<Sparkle size={14} weight={installState === "done" ? "fill" : "regular"} />}
              onClick={installSkill}
              isDisabled={installState === "installing" || installState === "done"}
              isLoading={installState === "installing"}
              tooltip={installState === "error" ? installErr : t("skills.installSkillTitle")}
              size="sm"
              variant={installState === "done" ? "secondary" : installState === "error" ? "destructive" : "secondary"}
            >
              {installLabel}
            </Button>
          )}
          <div className="ap-drop-wrap" ref={dropRef}>
            <ButtonGroup label={t("artifacts.actions")}>
              <Button
                label={t("artifacts.download")}
                icon={<DownloadSimple size={14} />}
                onClick={download}
                isDisabled={isWritingSelected}
                tooltip={t("artifacts.download")}
                size="sm"
                variant="secondary"
              />
              <IconButton
                label={t("artifacts.more")}
                icon={<CaretDown size={10} />}
                onClick={() => setDropOpen((o) => !o)}
                isDisabled={content === null}
                tooltip={t("artifacts.more")}
                size="sm"
                variant="secondary"
              />
            </ButtonGroup>
            {dropOpen && (
              <div className="ap-drop-menu">
                <button className="ap-drop-item" onClick={copy}>
                  <Copy size={13} />
                  {t("artifacts.copy")}
                </button>
              </div>
            )}
          </div>
          <ButtonGroup label={t("artifacts.tools")}>
            <IconButton
              label={t("artifacts.refresh")}
              icon={<ArrowClockwise size={15} />}
              onClick={refresh}
              tooltip={t("artifacts.refresh")}
              size="sm"
              variant="ghost"
            />
            <IconButton
              label={t("artifacts.close")}
              icon={<X size={15} />}
              onClick={onClose}
              tooltip={t("artifacts.close")}
              size="sm"
              variant="ghost"
            />
          </ButtonGroup>
        </div>
      </div>

      <div className="art-content">
        {isWritingSelected && (
          <div className="art-writing-placeholder">
            <div className="art-writing-dot" />
            {t("artifacts.writing")}
          </div>
        )}
        {!isWritingSelected && tab === "render" && (
          <RenderView artifact={selected} content={content} loading={isLoading} />
        )}
        {!isWritingSelected && tab === "code" && (
          <CodeView artifact={selected} content={content} loading={isLoading} />
        )}
      </div>
    </aside>
  );
}
