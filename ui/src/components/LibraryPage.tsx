/** Library — unified full page that merges chat search and the files gallery
 *  behind a single shared search box and a Chats | Files tab switcher. */

import { useMemo, useState } from "react";
import { Chats, Images, ArrowLeft } from "@phosphor-icons/react";
import type { ChatSession } from "../hooks/useChats";
import { collectAllFiles } from "../utils/collectAllFiles";
import { AllChatsPage } from "./AllChatsPage";
import { FilesGalleryPage } from "./FilesGalleryPage";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";

type TabValue = "chats" | "files";

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
        <Button variant="ghost" isIconOnly icon={<ArrowLeft size={18} weight="bold" />} label={t("library.close")} onClick={onBack} />

        <TabList value={tab} onChange={(v) => setTab(v as TabValue)}>
          <Tab
            value="chats"
            icon={<Chats size={16} weight="regular" />}
            selectedIcon={<Chats size={16} weight="fill" />}
            label={t("library.tabChats")}
            endContent={<span className="lib-tab-count">{sessions.length}</span>}
          />
          <Tab
            value="files"
            icon={<Images size={16} weight="regular" />}
            selectedIcon={<Images size={16} weight="fill" />}
            label={t("library.tabFiles")}
            endContent={<span className="lib-tab-count">{fileCount}</span>}
          />
        </TabList>

        <TextInput
          label={tab === "chats" ? t("library.searchChats") : t("library.searchFiles")}
          value={query}
          onChange={(value: string) => setQuery(value)}
          placeholder={tab === "chats" ? t("library.searchChats") : t("library.searchFiles")}
          isLabelHidden
          hasAutoFocus
        />
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
