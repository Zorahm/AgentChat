/** Single project, Claude-style: composer + chat list on the left, Instructions
 * and Files cards on the right. Instructions edit opens a modal. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Plus, Trash, PencilSimple, FileText, UploadSimple,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { ChatInput } from "../Chat/ChatInput";
import { useFileDrop } from "../../hooks/useFileDrop";
import { useWindowFileDrag } from "../../hooks/useWindowFileDrag";
import type { ModelItem } from "../Chat/ChatView";
import type { UseProjectsResult } from "../../hooks/useProjects";
import { makeDirSlug, getWebSearchDefault, getResearchDefault } from "../../hooks/useChats";
import type { SessionSeed } from "../../hooks/useChats";
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
    dirSlug?: string,
    seed?: SessionSeed,
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
  // Slug for the chat the composer is about to spawn. Pre-allocated so a file
  // attached here uploads straight into that chat's sandbox (chats/{slug}/
  // uploads/) instead of the out-of-sandbox cache dir — otherwise the model
  // can't read the first message's attachments. Regenerated after each send.
  const [composeSlug, setComposeSlug] = useState(() => makeDirSlug());

  // Composer toggles for the chat this project is about to spawn. There's no
  // session yet, so they live here (seeded from the same sticky defaults as a
  // normal new chat) and are threaded into the new session on send — without
  // them the project composer's "+" menu would be missing the web-search,
  // research and MCP sections that the main composer shows.
  const [webSearchEnabled, setWebSearchEnabled] = useState(() => getWebSearchDefault().enabled);
  const [webSearchMode, setWebSearchMode] = useState(() => getWebSearchDefault().mode);
  const [researchEnabled, setResearchEnabled] = useState(() => getResearchDefault());
  const [mcpEnabled, setMcpEnabled] = useState<string[]>([]);

  const handleWebSearchChange = useCallback((enabled: boolean, mode?: string) => {
    setWebSearchEnabled(enabled);
    if (mode) setWebSearchMode(mode);
  }, []);
  const handleToggleMcpServer = useCallback((serverId: string) => {
    setMcpEnabled((prev) =>
      prev.includes(serverId) ? prev.filter((id) => id !== serverId) : [...prev, serverId],
    );
  }, []);

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

  // Drag files onto the Files card to add them to the project's knowledge.
  const { dragging: filesDragging, handlers: filesDrop } = useFileDrop(
    (files) => void handleUpload(files),
  );
  // The moment a file enters the window, light up BOTH drop zones (Claude-style)
  // so the user can aim at either the composer or the project-knowledge card.
  const windowDragging = useWindowFileDrag();

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
          <Button
            label={t("projects.allProjects")}
            variant="ghost"
            icon={<ArrowLeft weight="bold" />}
            onClick={onBack}
            className="proj-back"
          />
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
        <Button
          label={t("projects.allProjects")}
          variant="ghost"
          icon={<ArrowLeft weight="bold" />}
          onClick={onBack}
          className="proj-back"
        />

        <div className="proj-title-row">
          <input
            className="proj-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
          <IconButton
            label={t("projects.deleteProject")}
            icon={<Trash />}
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
          />
        </div>

        <ChatInput
          onSend={(text, attachments, html) => {
            onStartChat(projectId, text, attachments, html, composeSlug, {
              webSearchEnabled,
              webSearchMode,
              researchEnabled,
              mcpEnabledServers: mcpEnabled,
            });
            setComposeSlug(makeDirSlug()); // fresh sandbox for the next message
          }}
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
          dirSlug={composeSlug}
          externalDragActive={windowDragging}
          webSearchEnabled={webSearchEnabled}
          webSearchMode={webSearchMode}
          onWebSearchChange={handleWebSearchChange}
          researchEnabled={researchEnabled}
          onResearchChange={setResearchEnabled}
          mcpEnabled={mcpEnabled}
          onToggleMcpServer={handleToggleMcpServer}
        />

        <div className="proj-chats-head">{t("projects.chatSectionTitle")}</div>
        {projectChats.length === 0 ? (
          <div className="proj-files-empty">{t("projects.noChats")}</div>
        ) : (
          <ul className="proj-chats">
            {projectChats.map((c) => (
              <li key={c.id} className="proj-chat-row">
                <div
                  className="proj-chat-row-content"
                  onClick={() => onOpenChat(c.id)}
                >
                  <div className="proj-chat-info">
                    <div className="proj-chat-title">{c.title}</div>
                    <div className="proj-chat-time">
                      {t("projects.lastMessage")} {formatRelative(c.updatedAt ?? c.createdAt)}
                    </div>
                  </div>
                </div>
                <IconButton
                  label={t("projects.deleteChat")}
                  icon={<Trash />}
                  variant="ghost"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); onDeleteChat(c.id); }}
                  className="proj-chat-del"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Right: instructions + files cards ──────────────────────── */}
      <aside className="proj-detail-side">
        <Card className="proj-card-panel">
          <div className="proj-card-head">
            <span className="proj-card-title">{t("projects.instructions")}</span>
            <IconButton
              label={t("projects.edit")}
              icon={<PencilSimple />}
              variant="ghost"
              size="sm"
              onClick={openInstrEditor}
            />
          </div>
          {instr ? (
            <p className="proj-card-text" onClick={openInstrEditor}>{instr}</p>
          ) : (
            <Button
              label={t("projects.instructionsEmpty")}
              variant="ghost"
              onClick={openInstrEditor}
              className="proj-card-empty"
            />
          )}
        </Card>

        <Card
          className={`proj-card-panel proj-files-panel${filesDragging || windowDragging ? " proj-files-panel--dragging" : ""}`}
          {...filesDrop}
        >
          {(filesDragging || windowDragging) && (
            <div className="proj-drop" aria-hidden>
              <FileText size={26} weight="light" />
              <span>{t("projects.dropToKnowledge")}</span>
            </div>
          )}
          <div className="proj-card-head">
            <span className="proj-card-title">{t("projects.files")}</span>
            <IconButton
              label={t("projects.addFiles")}
              icon={uploading ? <UploadSimple className="proj-spin" /> : <Plus weight="bold" />}
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              isDisabled={uploading}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { void handleUpload(e.target.files); e.target.value = ""; }}
            />
          </div>
          {project.files.length === 0 ? (
            <Button
              label={t("projects.filesEmpty")}
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              className="proj-card-empty"
            />
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
        </Card>
      </aside>

      {/* ── Instructions modal ─────────────────────────────────────── */}
      <Dialog
        isOpen={editingInstr}
        onOpenChange={setEditingInstr}
        width={500}
      >
        <div className="proj-modal-content">
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
            <Button
              label={t("projects.cancel")}
              variant="secondary"
              onClick={() => setEditingInstr(false)}
            />
            <Button
              label={savingInstr ? t("projects.saving") : t("projects.save")}
              variant="primary"
              onClick={() => void saveInstructions()}
              isDisabled={savingInstr}
              isLoading={savingInstr}
            />
          </div>
        </div>
      </Dialog>

      {/* ── File text modal ────────────────────────────────────────── */}
      <Dialog
        isOpen={fileView !== null}
        onOpenChange={(open) => {
          if (!open) setFileView(null);
        }}
        width={700}
      >
        <div className="proj-modal-content">
          <div className="proj-modal-filehead">
            <h3 className="proj-modal-title">{fileView?.name}</h3>
            <IconButton
              label={t("projects.close")}
              icon={<span>×</span>}
              variant="ghost"
              size="sm"
              onClick={() => setFileView(null)}
            />
          </div>
          {fileLoading ? (
            <div className="proj-files-empty">{t("projects.loading")}</div>
          ) : fileView?.text.trim() ? (
            <pre className="proj-filetext">{fileView.text}</pre>
          ) : (
            <div className="proj-files-empty">
              {t("projects.fileTextEmpty")}
            </div>
          )}
        </div>
      </Dialog>

      {/* ── Delete confirm ─────────────────────────────────────────── */}
      <AlertDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("projects.deleteConfirm")}
        description={t("projects.deleteMessage")}
        cancelLabel={t("projects.cancel")}
        actionLabel={t("projects.delete")}
        actionVariant="destructive"
        onAction={() => void handleDeleteProject()}
      />
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
    <Card className="proj-file-chip">
      <div className="proj-file-chip-top">
        <FileText className="proj-file-icon" />
        <IconButton
          label={t("projects.deleteFile")}
          icon={<span>×</span>}
          variant="ghost"
          size="sm"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="proj-file-chip-x"
        />
      </div>
      <div className="proj-file-chip-name" onClick={onOpen} role="button" title={t("projects.openText")}>{file.name}</div>
      <div className="proj-file-chip-meta">
        {meta}
        {file.extract_status === "failed" && <span className="proj-badge proj-badge--warn">{t("projects.notExtracted")}</span>}
      </div>
      <span className="proj-file-chip-badge">{ext}</span>
    </Card>
  );
}

function formatSize(bytes: number, t?: (key: string) => string): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} ${t ? t("projects.kb") : "KB"}`;
  return `${(kb / 1024).toFixed(1)} ${t ? t("projects.mb") : "MB"}`;
}
