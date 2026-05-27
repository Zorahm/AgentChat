/** Single project, Claude-style: composer + chat list on the left, Instructions
 * and Files cards on the right. Instructions edit opens a modal. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Plus, Trash, PencilSimple, FileText, UploadSimple,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
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
  effortLevel: string | null;
  onEffortChange: (v: string | null) => void;
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
  effortLevel, onEffortChange,
  onBack, onOpenChat, onStartChat, onDeleteChat,
}: ProjectDetailProps) {
  const { t } = useTranslation();
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
            <ArrowLeft weight="bold" /> {t("projects.allProjects")}
          </button>
          <div className="proj-empty">{t("projects.loading")}</div>
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
          <ArrowLeft weight="bold" /> {t("projects.allProjects")}
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
            title={t("projects.deleteProject")}
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
          effortLevel={effortLevel}
          onEffortChange={onEffortChange}
          placeholder={t("projects.chatPlaceholder")}
        />

        <div className="proj-chats-head">{t("projects.chatSectionTitle")}</div>
        {projectChats.length === 0 ? (
          <div className="proj-files-empty">{t("projects.noChats")}</div>
        ) : (
          <ul className="proj-chats">
            {projectChats.map((c) => (
              <li key={c.id} className="proj-chat-row" onClick={() => onOpenChat(c.id)}>
                <div className="proj-chat-info">
                  <div className="proj-chat-title">{c.title}</div>
                  <div className="proj-chat-time">
                    {t("projects.lastMessage")} {formatRelative(c.updatedAt ?? c.createdAt)}
                  </div>
                </div>
                <button
                  className="proj-icon-btn proj-icon-btn--sm proj-chat-del"
                  onClick={(e) => { e.stopPropagation(); onDeleteChat(c.id); }}
                  title={t("projects.deleteChat")}
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
            <span className="proj-card-title">{t("projects.instructions")}</span>
            <button className="proj-icon-btn proj-icon-btn--sm" onClick={openInstrEditor} title={t("projects.edit")}>
              <PencilSimple />
            </button>
          </div>
          {instr ? (
            <p className="proj-card-text" onClick={openInstrEditor}>{instr}</p>
          ) : (
            <button className="proj-card-empty" onClick={openInstrEditor}>
              {t("projects.instructionsEmpty")}
            </button>
          )}
        </div>

        <div className="proj-card-panel">
          <div className="proj-card-head">
            <span className="proj-card-title">{t("projects.files")}</span>
            <button
              className="proj-icon-btn proj-icon-btn--sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title={t("projects.addFiles")}
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
              {t("projects.filesEmpty")}
            </button>
          ) : (
            <div className="proj-files-grid">
              {project.files.map((f) => (
                <FileChip
                  key={f.id}
                  file={f}
                  onOpen={() => void openFile(f)}
                  onDelete={() => void handleDeleteFile(f.id)}
                  t={t}
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
            <h3 className="proj-modal-title">{t("projects.instructionsModalTitle")}</h3>
            <p className="proj-modal-hint">
              {t("projects.instructionsHint")}
            </p>
            <textarea
              className="proj-modal-textarea"
              value={instrDraft}
              onChange={(e) => setInstrDraft(e.target.value)}
              rows={12}
              autoFocus
            />
            <div className="proj-modal-actions">
              <button className="proj-btn" onClick={() => setEditingInstr(false)}>{t("projects.cancel")}</button>
              <button
                className="proj-btn proj-btn--primary"
                onClick={() => void saveInstructions()}
                disabled={savingInstr}
              >
                {savingInstr ? t("projects.saving") : t("projects.save")}
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
              <button className="proj-icon-btn proj-icon-btn--sm" onClick={() => setFileView(null)} title={t("projects.close")}>
                ×
              </button>
            </div>
            {fileLoading ? (
              <div className="proj-files-empty">{t("projects.loading")}</div>
            ) : fileView.text.trim() ? (
              <pre className="proj-filetext">{fileView.text}</pre>
            ) : (
              <div className="proj-files-empty">
                {t("projects.fileTextEmpty")}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Delete confirm ─────────────────────────────────────────── */}
      {confirmDelete && (
        <div className="proj-confirm-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="proj-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>{t("projects.deleteConfirm")}</h3>
            <p>{t("projects.deleteMessage")}</p>
            <div className="proj-confirm-actions">
              <button className="proj-btn" onClick={() => setConfirmDelete(false)}>{t("projects.cancel")}</button>
              <button className="proj-btn proj-btn--danger" onClick={() => void handleDeleteProject()}>
                {t("projects.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileChip(
  { file, onOpen, onDelete, t }: { file: ProjectFileInfo; onOpen: () => void; onDelete: () => void; t: (key: string) => string },
) {
  const ext = file.name.includes(".")
    ? file.name.split(".").pop()!.toUpperCase().slice(0, 5)
    : "FILE";
  const meta = file.extract_status === "ok" && file.text_len > 0
    ? `${file.text_len.toLocaleString()} ${t("projects.chars")}`
    : formatSize(file.size, t);
  return (
    <div className="proj-file-chip" onClick={onOpen} title={t("projects.openText")}>
      <div className="proj-file-chip-top">
        <FileText className="proj-file-icon" />
        <button
          className="proj-file-chip-x"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={t("projects.deleteFile")}
        >×</button>
      </div>
      <div className="proj-file-chip-name">{file.name}</div>
      <div className="proj-file-chip-meta">
        {meta}
        {file.extract_status === "failed" && <span className="proj-badge proj-badge--warn">{t("projects.notExtracted")}</span>}
      </div>
      <span className="proj-file-chip-badge">{ext}</span>
    </div>
  );
}

function formatSize(bytes: number, t?: (key: string) => string): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} ${t ? t("projects.kb") : "KB"}`;
  return `${(kb / 1024).toFixed(1)} ${t ? t("projects.mb") : "MB"}`;
}
