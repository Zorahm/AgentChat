/** Projects surface — grid of projects, or the detail of one. Owns useProjects.
 * Rendered inside the main app grid so the shared Sidebar stays visible. */

import { useCallback, useState } from "react";
import { Plus, FolderOpen, X, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useProjects } from "../../hooks/useProjects";
import type { ModelItem } from "../Chat/ChatView";
import type { ChatSession, AttachmentInfo } from "../../types/chat";
import type { SessionSeed } from "../../hooks/useChats";
import { ProjectDetail } from "./ProjectDetail";

interface ProjectsViewProps {
  sessions: ChatSession[];
  models: ModelItem[];
  model: string;
  onModelChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  effortLevel: string | null;
  onEffortChange: (v: string | null) => void;
  onClose: () => void;
  onOpenChat: (id: string) => void;
  onStartChat: (
    projectId: string,
    text: string,
    attachments: AttachmentInfo[],
    html?: string,
    dirSlug?: string,
    seed?: SessionSeed,
  ) => void;
  onDeleteChat: (id: string) => void;
}

export function ProjectsView({
  sessions,
  models,
  model,
  onModelChange,
  thinkingEnabled,
  onThinkingToggle,
  effortLevel,
  onEffortChange,
  onClose,
  onOpenChat,
  onStartChat,
  onDeleteChat,
}: ProjectsViewProps) {
  const { t } = useTranslation();
  const api = useProjects();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const proj = await api.createProject(newName.trim() || t("projects.defaultName"));
    setBusy(false);
    setNewName("");
    if (proj) setOpenId(proj.id);
  }, [api, newName, busy]);

  if (openId) {
    return (
      <ProjectDetail
        projectId={openId}
        api={api}
        sessions={sessions}
        models={models}
        model={model}
        onModelChange={onModelChange}
        thinkingEnabled={thinkingEnabled}
        onThinkingToggle={onThinkingToggle}
        effortLevel={effortLevel}
        onEffortChange={onEffortChange}
        onBack={() => setOpenId(null)}
        onOpenChat={onOpenChat}
        onStartChat={onStartChat}
        onDeleteChat={onDeleteChat}
      />
    );
  }

  return (
    <div className="proj-page">
      <header className="proj-head">
        <h1 className="proj-title">{t("projects.title")}</h1>
        <IconButton
          label={t("projects.backToChats")}
          icon={<X weight="bold" />}
          onClick={onClose}
          variant="ghost"
        />
      </header>

      <p className="proj-sub">
        {t("projects.description")}
      </p>

      <div className="proj-create">
        <TextInput
          label={t("projects.newPlaceholder")}
          isLabelHidden
          placeholder={t("projects.newPlaceholder")}
          value={newName}
          onChange={(v) => setNewName(v)}
        />
        <Button
          label={t("projects.create")}
          variant="primary"
          icon={<Plus weight="bold" />}
          onClick={() => void handleCreate()}
          isDisabled={busy}
          isLoading={busy}
        />
      </div>

      {api.projects.length === 0 ? (
        <div className="proj-empty">
          <FolderOpen size={40} weight="thin" />
          <span>{t("projects.empty")}</span>
        </div>
      ) : (
        <div className="proj-grid">
          {api.projects.map((p) => (
            <div key={p.id} className="proj-card-wrap">
              <ClickableCard
                label={p.name}
                onClick={() => setOpenId(p.id)}
                className="proj-card"
              >
                <div className="proj-card-icon">
                  <FolderOpen size={22} weight="duotone" />
                </div>
                <div className="proj-card-name">{p.name}</div>
                <div className="proj-card-meta">
                  {p.file_count} {t("projects.files", { count: p.file_count })}
                  {p.instructions.trim() ? " · " + t("projects.hasPrompt") : ""}
                </div>
              </ClickableCard>
              <IconButton
                label={t("projects.deleteProject")}
                icon={<Trash />}
                variant="ghost"
                onClick={() => setConfirmId(p.id)}
                className="proj-card-del"
              />
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        isOpen={confirmId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmId(null);
        }}
        title={t("projects.deleteConfirm")}
        description={t("projects.deleteMessage")}
        cancelLabel={t("projects.cancel")}
        actionLabel={t("projects.delete")}
        actionVariant="destructive"
        onAction={() => {
          const id = confirmId;
          setConfirmId(null);
          void api.deleteProject(id ?? "");
        }}
      />
    </div>
  );
}


