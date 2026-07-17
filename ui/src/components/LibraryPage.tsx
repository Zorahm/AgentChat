/** Library — unified full page that merges chat search and the files gallery
 *  behind a single shared search box and a Chats | Files tab switcher. */

import { useMemo, useState } from "react";
import { ArrowLeft, MagnifyingGlass, X, Chats, Images } from "@phosphor-icons/react";
import type { ChatSession } from "../hooks/useChats";
import { collectAllFiles } from "../utils/collectAllFiles";
import { AllChatsPage } from "./AllChatsPage";
import { FilesGalleryPage } from "./FilesGalleryPage";
import { useTranslation } from "react-i18next";

type Tab = "chats" | "files";

interface LibraryPageProps {
  sessions: ChatSession[];
  activeId: string;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onOpenFile: (sessionId: string, path: string) => void;
  onGotoChat: (sessionId: string) => void;
  onBack: () => void;
  initialTab?: Tab;
}

export function LibraryPage({
  sessions, activeId, onSwitch, onDelete, onRename, onPin,
  onOpenFile, onGotoChat, onBack, initialTab = "chats",
}: LibraryPageProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");

  const fileCount = useMemo(() => collectAllFiles(sessions).length, [sessions]);

  return (
    <div className="lib-page">
      <div className="lib-head">
        <button className="lib-back" onClick={onBack} title={t("library.close")}>
          <ArrowLeft size={18} weight="bold" />
        </button>

        <div className="lib-tabs">
          <button
            className={`lib-tab${tab === "chats" ? " active" : ""}`}
            onClick={() => setTab("chats")}
          >
            <Chats size={16} weight={tab === "chats" ? "fill" : "regular"} />
            <span>{t("library.tabChats")}</span>
            <span className="lib-tab-count">{sessions.length}</span>
          </button>
          <button
            className={`lib-tab${tab === "files" ? " active" : ""}`}
            onClick={() => setTab("files")}
          >
            <Images size={16} weight={tab === "files" ? "fill" : "regular"} />
            <span>{t("library.tabFiles")}</span>
            <span className="lib-tab-count">{fileCount}</span>
          </button>
        </div>

        <div className="lib-search">
          <MagnifyingGlass size={15} className="lib-search-icon" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "chats" ? t("library.searchChats") : t("library.searchFiles")}
            autoFocus
          />
          {query && (
            <button className="lib-search-clear" onClick={() => setQuery("")}>
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
      </div>

      <div className="lib-body">
        {tab === "chats" ? (
          <AllChatsPage
            embedded
            query={query}
            onQueryChange={setQuery}
            sessions={sessions}
            activeId={activeId}
            onSwitch={onSwitch}
            onDelete={onDelete}
            onRename={onRename}
            onPin={onPin}
            onBack={onBack}
          />
        ) : (
          <FilesGalleryPage
            embedded
            query={query}
            sessions={sessions}
            onOpenFile={onOpenFile}
            onGotoChat={onGotoChat}
            onBack={onBack}
          />
        )}
      </div>
    </div>
  );
}
