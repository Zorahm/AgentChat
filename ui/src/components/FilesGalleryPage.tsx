/** Files gallery — every uploaded and model-generated file across all chats. */

import { useMemo, useState } from "react";
import { MagnifyingGlass, X, ArrowSquareOut, ChatCircle, Images } from "@phosphor-icons/react";
import type { ChatSession } from "../hooks/useChats";
import { collectAllFiles, type GalleryFile } from "../utils/collectAllFiles";
import { fileExtIcon } from "../utils/toolIcons";
import { API_BASE } from "../utils/apiBase";
import { useTranslation } from "react-i18next";

interface FilesGalleryPageProps {
  sessions: ChatSession[];
  onOpenFile: (sessionId: string, path: string) => void;
  onGotoChat: (sessionId: string) => void;
  onBack: () => void;
}

type Filter = "all" | "attachment" | "artifact";

function imageSrc(f: GalleryFile): string | null {
  if (f.dataUrl) return f.dataUrl;
  if (f.path) return `${API_BASE}/files/serve?path=${encodeURIComponent(f.path)}`;
  return null;
}

export function FilesGalleryPage({ sessions, onOpenFile, onGotoChat, onBack }: FilesGalleryPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const all = useMemo(() => collectAllFiles(sessions), [sessions]);
  const files = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (f) =>
        (filter === "all" || f.source === filter) &&
        (q === "" || f.name.toLowerCase().includes(q) || f.sessionTitle.toLowerCase().includes(q)),
    );
  }, [all, filter, query]);

  const counts = useMemo(
    () => ({
      all: all.length,
      attachment: all.filter((f) => f.source === "attachment").length,
      artifact: all.filter((f) => f.source === "artifact").length,
    }),
    [all],
  );

  return (
    <div className="fg-page">
      <div className="fg-head">
        <div className="fg-head-title"><Images size={20} weight="duotone" /> {t("filesGallery.title")}</div>
        <button className="fg-close" onClick={onBack} title={t("filesGallery.close")}>
          <X size={16} weight="bold" />
        </button>
      </div>

      <div className="fg-toolbar">
        <div className="fg-search">
          <MagnifyingGlass size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("filesGallery.search")}
            autoFocus
          />
        </div>
        <div className="fg-filters">
          {(["all", "attachment", "artifact"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`fg-filter${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {t(`filesGallery.filter.${f}`)} <span className="fg-filter-count">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {files.length === 0 ? (
        <div className="fg-empty">{t("filesGallery.empty")}</div>
      ) : (
        <div className="fg-grid">
          {files.map((f) => {
            const src = f.isImage ? imageSrc(f) : null;
            return (
              <div
                key={`${f.sessionId}-${f.path}`}
                className="fg-card"
                onClick={() => onOpenFile(f.sessionId, f.path)}
                title={f.path}
              >
                <div className="fg-thumb">
                  {src ? (
                    <img src={src} alt={f.name} loading="lazy" />
                  ) : (
                    <span className="fg-thumb-ic">{fileExtIcon(f.ext)}</span>
                  )}
                  <span className={`fg-badge fg-badge--${f.source}`}>
                    {t(f.source === "attachment" ? "filesGallery.uploaded" : "filesGallery.created")}
                  </span>
                </div>
                <div className="fg-meta">
                  <div className="fg-name">{f.name}</div>
                  <div className="fg-chat">{f.sessionTitle}</div>
                </div>
                <div className="fg-actions">
                  <button
                    className="fg-act"
                    onClick={(e) => { e.stopPropagation(); onOpenFile(f.sessionId, f.path); }}
                    title={t("filesGallery.open")}
                  >
                    <ArrowSquareOut size={14} /> {t("filesGallery.open")}
                  </button>
                  <button
                    className="fg-act"
                    onClick={(e) => { e.stopPropagation(); onGotoChat(f.sessionId); }}
                    title={t("filesGallery.gotoChat")}
                  >
                    <ChatCircle size={14} /> {t("filesGallery.gotoChat")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
