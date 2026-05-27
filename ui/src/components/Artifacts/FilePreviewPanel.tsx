/** Live file preview panel — tabs + scrolling + open-from-artifact. */

import { useEffect, useRef, useState } from "react";
import type { LiveFile } from "../../types/artifact";
import { getLang } from "../../utils/getLang";
import { basename } from "../../utils/basename";
import { useTranslation } from "react-i18next";

interface FilePreviewPanelProps {
  files: LiveFile[];
  closed: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

export function FilePreviewPanel({ files, closed, onClose, onOpenFile }: FilePreviewPanelProps) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const prevLen = useRef(files.length);

  // Auto-select last file when new writing file arrives, OR on first mount
  useEffect(() => {
    const isNew = files.length > prevLen.current;
    prevLen.current = files.length;

    if (isNew) {
      const last = files.at(-1);
      if (last && !last.done) {
        setActiveId(last.id);
        return;
      }
    }

    // On mount or when activeId is stale (file removed), pick last file
    if (activeId === null || !files.some((f) => f.id === activeId)) {
      const last = files.at(-1);
      if (last) setActiveId(last.id);
    }
  }, [files, activeId]);

  const active = files.find((f) => f.id === activeId) ?? null;

  // Auto-scroll while writing
  useEffect(() => {
    if (!active || active.done || !scrollRef.current || userScrolled.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active?.content, active]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    userScrolled.current = !atBottom;
  };

  // Fires when artifact "Open" is clicked in chat — forwards to parent
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (path && onOpenFile) onOpenFile(path);
    };
    window.addEventListener("open-artifact", handler);
    return () => window.removeEventListener("open-artifact", handler);
  }, [onOpenFile]);

  if (files.length === 0 || closed) {
    return (
      <aside className="preview">
        <div className="pv-placeholder">
          {closed ? t("artifacts.panelClosed") : t("artifacts.noFiles")}
        </div>
      </aside>
    );
  }

  const lines = (active?.content ?? "").split("\n");
  const fileName = active ? basename(active.path) : "";

  return (
    <aside className="preview">
      <div className="pv-tabs">
        {files.map((f, i) => {
          const shortName = basename(f.path);
          return (
            <div
              key={f.id}
              className={`pv-tab${f.id === activeId ? " active" : ""}`}
              onClick={() => setActiveId(f.id)}
              title={f.path}
            >
              {f.done ? <span className="done-mark">✓</span> : f.id === activeId ? <span className="dot" /> : <span className="done-mark">○</span>}
              {i + 1}. {shortName}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <button className="pv-close-btn" onClick={onClose} title={t("artifacts.closePanel")}>×</button>
      </div>

      {active && (
        <>
          <div className="pv-head">
            <span>📄 {active.path}</span>
            {!active.done && <span className="pv-writing">{t("artifacts.statusWriting")}</span>}
            {active.done && <span style={{ color: "var(--accent-2)" }}>✓ {t("artifacts.statusDone")}</span>}
          </div>
          <div className="pv-code" ref={scrollRef} onScroll={handleScroll}>
            {lines.map((line, i) => (
              <div className="pv-ln" key={i}>
                <span className="pv-lnno">{i + 1}</span>
                <span>{line || "\u00A0"}</span>
              </div>
            ))}
            {!active.done && (
              <div className="pv-ln">
                <span className="pv-lnno">{lines.length + 1}</span>
                <span><span className="pv-caret" /></span>
              </div>
            )}
          </div>
          <div className="pv-foot">
            <span>{getLang(active.path)} · {lines.length} {t("artifacts.lines")}{!active.done && ` · ${t("artifacts.autoScroll")}`}</span>
            <span>{active.content.length.toLocaleString()} {t("artifacts.chars")}</span>
          </div>
        </>
      )}
    </aside>
  );
}
