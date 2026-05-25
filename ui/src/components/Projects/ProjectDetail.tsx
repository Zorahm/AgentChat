/** Single project, Claude-style: composer + chat list on the left, Instructions
 * and Files cards on the right. Instructions edit opens a modal. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Plus, Trash, PencilSimple, FileText, UploadSimple,
} from "@phosphor-icons/react";
import { ChatInput } from "../Chat/ChatInput";
import type { ModelItem } from "../Chat/ChatView";
import type { UseProjectsResult } from "../../hooks/useProjects";
import type { ProjectFull, ProjectFileInfo, ProjectFileText } from "../../types/project";
import type { ChatSession, AttachmentInfo } from "../../types/chat";
import { formatRelative } from "../../utils/formatTime";

interface ProjectDetailProps {
  projectId: string;
  api: UseProjectsResult;
  sessions: ChatSession[];
  models: ModelItem[];
  model: string;
  onModelChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  onBack: () => void;
  onOpenChat: (id: string) => void;
  onStartChat: (
    projectId: string,
    text: string,
    attachments: AttachmentInfo[],
    html?: string,
  ) => void;
  onDeleteChat: (id: string) => void;
}

export function ProjectDetail({
  projectId, api, sessions, models, model, onModelChange,
  thinkingEnabled, onThinkingToggle,
  onBack, onOpenChat, onStartChat, onDeleteChat,
}: ProjectDetailProps) {
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [name, setName] = useState("");
  const [editingInstr, setEditingInstr] = useState(false);
  const [instrDraft, setInstrDraft] = useState("");
  const [savingInstr, setSavingInstr] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [fileView, setFileView] = useState<ProjectFileText | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const full = await api.getProject(projectId);
    if (full) {
      setProject(full);
      setName(full.name);
    }
  }, [api, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveName = useCallback(() => {
    const trimmed = name.trim();
    if (project && trimmed && trimmed !== project.name) {
      void api.updateProject(projectId, { name: trimmed });
    }
  }, [api, projectId, name, project]);

  const openInstrEditor = useCallback(() => {
    setInstrDraft(project?.instructions ?? "");
    setEditingInstr(true);
  }, [project]);

  const saveInstructions = useCallback(async () => {
    if (!project) return;
    setSavingInstr(true);
    const updated = await api.updateProject(projectId, { instructions: instrDraft });
    setSavingInstr(false);
    if (updated) setProject((p) => (p ? { ...p, instructions: updated.instructions } : p));
    setEditingInstr(false);
  }, [api, projectId, instrDraft, project]);

  const handleUpload = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setUploading(true);
      await api.uploadFiles(projectId, Array.from(fileList));
      setUploading(false);
      await reload();
    },
    [api, projectId, reload],
  );

  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      await api.deleteFile(projectId, fileId);
      await reload();
    },
    [api, projectId, reload],
  );

  const openFile = useCallback(
    async (f: ProjectFileInfo) => {
      setFileLoading(true);
      setFileView({ id: f.id, name: f.name, mime_type: f.mime_type, extract_status: f.extract_status, text: "" });
      const res = await api.getFileText(projectId, f.id);
      setFileLoading(false);
      if (res) setFileView(res);
    },
    [api, projectId],
  );

  const handleDeleteProject = useCallback(async () => {
    await api.deleteProject(projectId);
    onBack();
  }, [api, projectId, onBack]);

  const projectChats = sessions
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));

  if (!project) {
    return (
      <div className="proj-detail">
        <div className="proj-detail-main">
          <button className="proj-back" onClick={onBack}>
            <ArrowLeft weight="bold" /> Все проекты
          </button>
          <div className="proj-empty">Загрузка…</div>
        </div>
      </div>
    );
  }

  const instr = project.instructions.trim();

  return (
    <div className="proj-detail">
      {/* ── Left: title, composer, chats ───────────────────────────── */}
      <div className="proj-detail-main">
        <button className="proj-back" onClick={onBack}>
          <ArrowLeft weight="bold" /> Все проекты
        </button>

        <div className="proj-title-row">
          <input
            className="proj-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
          <button
            className="proj-icon-btn"
            onClick={() => setConfirmDelete(true)}
            title="Удалить проект"
          >
            <Trash />
          </button>
        </div>

        <ChatInput
          onSend={(text, attachments, html) => onStartChat(projectId, text, attachments, html)}
          onStop={() => {}}
          isStreaming={false}
          models={models}
          model={model}
          onModelChange={onModelChange}
          thinkingEnabled={thinkingEnabled}
          onThinkingToggle={onThinkingToggle}
          placeholder="Чем помочь сегодня?"
        />

        <div className="proj-chats-head">Чаты проекта</div>
        {projectChats.length === 0 ? (
          <div className="proj-files-empty">Чатов пока нет — начните новый выше.</div>
        ) : (
          <ul className="proj-chats">
            {projectChats.map((c) => (
              <li key={c.id} className="proj-chat-row" onClick={() => onOpenChat(c.id)}>
                <div className="proj-chat-info">
                  <div className="proj-chat-title">{c.title}</div>
                  <div className="proj-chat-time">
                    Последнее сообщение {formatRelative(c.updatedAt ?? c.createdAt)}
                  </div>
                </div>
                <button
                  className="proj-icon-btn proj-icon-btn--sm proj-chat-del"
                  onClick={(e) => { e.stopPropagation(); onDeleteChat(c.id); }}
                  title="Удалить чат"
                >
                  <Trash />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Right: instructions + files cards ──────────────────────── */}
      <aside className="proj-detail-side">
        <div className="proj-card-panel">
          <div className="proj-card-head">
            <span className="proj-card-title">Инструкции</span>
            <button className="proj-icon-btn proj-icon-btn--sm" onClick={openInstrEditor} title="Редактировать">
              <PencilSimple />
            </button>
          </div>
          {instr ? (
            <p className="proj-card-text" onClick={openInstrEditor}>{instr}</p>
          ) : (
            <button className="proj-card-empty" onClick={openInstrEditor}>
              Добавьте промпт — он передаётся модели в каждом чате проекта.
            </button>
          )}
        </div>

        <div className="proj-card-panel">
          <div className="proj-card-head">
            <span className="proj-card-title">Файлы</span>
            <button
              className="proj-icon-btn proj-icon-btn--sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Добавить файлы"
            >
              {uploading ? <UploadSimple className="proj-spin" /> : <Plus weight="bold" />}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { void handleUpload(e.target.files); e.target.value = ""; }}
            />
          </div>
          {project.files.length === 0 ? (
            <button className="proj-card-empty" onClick={() => fileInputRef.current?.click()}>
              Word, PDF, Excel и текст сразу превращаются в текст для модели.
            </button>
          ) : (
            <div className="proj-files-grid">
              {project.files.map((f) => (
                <FileChip
                  key={f.id}
                  file={f}
                  onOpen={() => void openFile(f)}
                  onDelete={() => void handleDeleteFile(f.id)}
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── Instructions modal ─────────────────────────────────────── */}
      {editingInstr && (
        <div className="proj-modal-overlay" onClick={() => setEditingInstr(false)}>
          <div className="proj-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="proj-modal-title">Инструкции проекта</h3>
            <p className="proj-modal-hint">
              Например: «Отвечай кратко, на русском. Ты — ассистент по проекту X.»
            </p>
            <textarea
              className="proj-modal-textarea"
              value={instrDraft}
              onChange={(e) => setInstrDraft(e.target.value)}
              rows={12}
              autoFocus
            />
            <div className="proj-modal-actions">
              <button className="proj-btn" onClick={() => setEditingInstr(false)}>Отмена</button>
              <button
                className="proj-btn proj-btn--primary"
                onClick={() => void saveInstructions()}
                disabled={savingInstr}
              >
                {savingInstr ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── File text modal ────────────────────────────────────────── */}
      {fileView && (
        <div className="proj-modal-overlay" onClick={() => setFileView(null)}>
          <div className="proj-modal proj-modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="proj-modal-filehead">
              <h3 className="proj-modal-title">{fileView.name}</h3>
              <button className="proj-icon-btn proj-icon-btn--sm" onClick={() => setFileView(null)} title="Закрыть">
                ×
              </button>
            </div>
            {fileLoading ? (
              <div className="proj-files-empty">Загрузка…</div>
            ) : fileView.text.trim() ? (
              <pre className="proj-filetext">{fileView.text}</pre>
            ) : (
              <div className="proj-files-empty">
                Текст не извлечён — модель откроет файл напрямую при необходимости.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Delete confirm ─────────────────────────────────────────── */}
      {confirmDelete && (
        <div className="proj-confirm-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="proj-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Удалить проект?</h3>
            <p>Файлы проекта будут удалены. Чаты останутся, но потеряют связь с проектом.</p>
            <div className="proj-confirm-actions">
              <button className="proj-btn" onClick={() => setConfirmDelete(false)}>Отмена</button>
              <button className="proj-btn proj-btn--danger" onClick={() => void handleDeleteProject()}>
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileChip(
  { file, onOpen, onDelete }: { file: ProjectFileInfo; onOpen: () => void; onDelete: () => void },
) {
  const ext = file.name.includes(".")
    ? file.name.split(".").pop()!.toUpperCase().slice(0, 5)
    : "FILE";
  const meta = file.extract_status === "ok" && file.text_len > 0
    ? `${file.text_len.toLocaleString("ru-RU")} симв.`
    : formatSize(file.size);
  return (
    <div className="proj-file-chip" onClick={onOpen} title="Открыть текст">
      <div className="proj-file-chip-top">
        <FileText className="proj-file-icon" />
        <button
          className="proj-file-chip-x"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Удалить файл"
        >×</button>
      </div>
      <div className="proj-file-chip-name">{file.name}</div>
      <div className="proj-file-chip-meta">
        {meta}
        {file.extract_status === "failed" && <span className="proj-badge proj-badge--warn">не извлечён</span>}
      </div>
      <span className="proj-file-chip-badge">{ext}</span>
    </div>
  );
}

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} КБ`;
  return `${(kb / 1024).toFixed(1)} МБ`;
}
