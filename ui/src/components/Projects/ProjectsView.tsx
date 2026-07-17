/** Projects surface — grid of projects, or the detail of one. Owns useProjects.
 * Rendered inside the main app grid so the shared Sidebar stays visible. */

import { useCallback, useState } from "react";
import { Plus, FolderOpen, X, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
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
        <button className="proj-icon-btn" onClick={onClose} title={t("projects.backToChats")}>
          <X weight="bold" />
        </button>
      </header>

      <p className="proj-sub">
        {t("projects.description")}
      </p>

      <div className="proj-create">
        <input
          className="proj-input"
          placeholder={t("projects.newPlaceholder")}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
        />
        <button className="proj-btn proj-btn--primary" onClick={() => void handleCreate()} disabled={busy}>
          <Plus weight="bold" /> {t("projects.create")}
        </button>
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
              <button className="proj-card" onClick={() => setOpenId(p.id)}>
                <div className="proj-card-icon">
                  <FolderOpen size={22} weight="duotone" />
                </div>
                <div className="proj-card-name">{p.name}</div>
                <div className="proj-card-meta">
                  {p.file_count} {t("projects.files", { count: p.file_count })}
                  {p.instructions.trim() ? " · " + t("projects.hasPrompt") : ""}
                </div>
              </button>
              <button
                className="proj-card-del"
                onClick={() => setConfirmId(p.id)}
                title={t("projects.deleteProject")}
              >
                <Trash />
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmId && (
        <div className="proj-confirm-overlay" onClick={() => setConfirmId(null)}>
          <div className="proj-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>{t("projects.deleteConfirm")}</h3>
            <p>{t("projects.deleteMessage")}</p>
            <div className="proj-confirm-actions">
              <button className="proj-btn" onClick={() => setConfirmId(null)}>{t("projects.cancel")}</button>
              <button
                className="proj-btn proj-btn--danger"
                onClick={() => {
                  const id = confirmId;
                  setConfirmId(null);
                  void api.deleteProject(id);
                }}
              >
                {t("projects.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


