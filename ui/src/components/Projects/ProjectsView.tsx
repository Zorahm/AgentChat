/** Projects surface — grid of projects, or the detail of one. Owns useProjects.
 * Rendered inside the main app grid so the shared Sidebar stays visible. */

import { useCallback, useState } from "react";
import { Plus, FolderOpen, X, Trash } from "@phosphor-icons/react";
import { useProjects } from "../../hooks/useProjects";
import type { ModelItem } from "../Chat/ChatView";
import type { ChatSession, AttachmentInfo } from "../../types/chat";
import { ProjectDetail } from "./ProjectDetail";

interface ProjectsViewProps {
  sessions: ChatSession[];
  models: ModelItem[];
  model: string;
  onModelChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  onClose: () => void;
  onOpenChat: (id: string) => void;
  onStartChat: (
    projectId: string,
    text: string,
    attachments: AttachmentInfo[],
    html?: string,
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
  onClose,
  onOpenChat,
  onStartChat,
  onDeleteChat,
}: ProjectsViewProps) {
  const api = useProjects();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const proj = await api.createProject(newName.trim() || "Новый проект");
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
        <h1 className="proj-title">Проекты</h1>
        <button className="proj-icon-btn" onClick={onClose} title="К чатам">
          <X weight="bold" />
        </button>
      </header>

      <p className="proj-sub">
        У проекта есть свой промпт и файлы. Они автоматически передаются модели в
        каждом чате проекта — файлы Word/PDF/Excel сразу как текст.
      </p>

      <div className="proj-create">
        <input
          className="proj-input"
          placeholder="Название нового проекта"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
        />
        <button className="proj-btn proj-btn--primary" onClick={() => void handleCreate()} disabled={busy}>
          <Plus weight="bold" /> Создать
        </button>
      </div>

      {api.projects.length === 0 ? (
        <div className="proj-empty">
          <FolderOpen size={40} weight="thin" />
          <span>Пока нет проектов. Создайте первый выше.</span>
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
                  {p.file_count} {fileWord(p.file_count)}
                  {p.instructions.trim() ? " · есть промпт" : ""}
                </div>
              </button>
              <button
                className="proj-card-del"
                onClick={() => setConfirmId(p.id)}
                title="Удалить проект"
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
            <h3>Удалить проект?</h3>
            <p>Файлы проекта будут удалены. Чаты останутся, но потеряют связь с проектом.</p>
            <div className="proj-confirm-actions">
              <button className="proj-btn" onClick={() => setConfirmId(null)}>Отмена</button>
              <button
                className="proj-btn proj-btn--danger"
                onClick={() => {
                  const id = confirmId;
                  setConfirmId(null);
                  void api.deleteProject(id);
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fileWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "файл";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "файла";
  return "файлов";
}
