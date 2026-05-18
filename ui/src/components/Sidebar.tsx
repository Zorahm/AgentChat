import { useState, useMemo } from "react";
import { Trash, PencilSimple, Check, X, Books, Plus, Gear } from "@phosphor-icons/react";
import type { ChatSession } from "../hooks/useChats";

interface SidebarProps {
  sessions: ChatSession[];
  activeId: string;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  activeView: "chat" | "skills" | "settings" | "allchats";
  onNavigate: (view: "chat" | "skills" | "settings" | "allchats") => void;
  collapsed: boolean;
  onToggle: () => void;
  userName: string;
}

const RECENT_LIMIT = 15;

export function Sidebar({
  sessions, activeId, onNew, onSwitch, onDelete, onRename,
  activeView, onNavigate, collapsed, onToggle, userName,
}: SidebarProps) {
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.createdAt - a.createdAt),
    [sessions],
  );

  const recent = sorted.slice(0, RECENT_LIMIT);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <button className="sb-icon-btn" onClick={onToggle} title="Expand sidebar">
          ☰
        </button>
        <button className="sb-icon-btn" onClick={onNew} title="New chat">
          <Plus />
        </button>
        <div className="sb-collapsed-dots">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`sb-collapsed-dot${s.id === activeId ? " active" : ""}`}
              onClick={() => { onSwitch(s.id); onNavigate("chat"); }}
              title={s.title}
            />
          ))}
        </div>
        <nav className="sb-foot-collapsed">
          <button
            className={`sb-icon-btn${activeView === "skills" ? " active" : ""}`}
            onClick={() => onNavigate("skills")}
            title="Skills"
          >
            <Books />
          </button>
          <button
            className={`sb-icon-btn${activeView === "settings" ? " active" : ""}`}
            onClick={() => onNavigate("settings")}
            title="Settings"
          >
            <Gear />
          </button>
        </nav>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="sb-logo">
          <img className="sb-logo-mark" src="/dots.svg" alt="AgentChat" />
          <span>AgentChat</span>
        </div>
        <button className="sb-icon-btn sb-hamburger" onClick={onToggle}>☰</button>
      </div>

      <div className="sb-body">
        <button className="sb-new-chat" onClick={onNew}>
          <span>+ New chat</span>
          <span className="sb-kbd">⌘N</span>
        </button>
        <button className="sb-skills-btn" onClick={() => onNavigate("skills")}>
          <Books />
          <span>Навыки</span>
        </button>

        <div className="sb-recent-header">
          <span className="sb-recent-label">Последние</span>
          <button className="sb-view-all-btn" onClick={() => onNavigate("allchats")}>
            View All
          </button>
        </div>

        <div className="sb-list">
          {recent.map((s) => (
            <ChatItem
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => { onSwitch(s.id); onNavigate("chat"); }}
              onDelete={() => onDelete(s.id)}
              onRename={(title) => onRename(s.id, title)}
            />
          ))}
        </div>
      </div>

      <div className="sb-foot">
        <div className="sb-user" onClick={() => onNavigate("settings")}>
          <div className="sb-avatar">{userName ? userName[0]!.toUpperCase() : "A"}</div>
          <div className="sb-user-name">
            {userName || "Пользователь"}
          </div>
          <span className="sb-user-gear"><Gear /></span>
        </div>
      </div>
    </aside>
  );
}

/* ── Chat Item ──────────────────────────────────────── */

function ChatItem({
  session,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(session.title);
    setEditing(true);
  };

  const handleSave = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    const trimmed = editTitle.trim();
    if (trimmed) onRename(trimmed);
    setEditing(false);
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave(e);
    if (e.key === "Escape") setEditing(false);
  };

  const hasActions = editing || hovered || active;

  return (
    <div
      className={`sb-chat-item${active ? " active" : ""}${hasActions ? " has-actions" : ""}`}
      onClick={editing ? undefined : onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {editing ? (
        <input
          className="sb-chat-edit"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => setEditing(false)}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="sb-chat-title">{session.title}</span>
      )}

      {editing ? (
        <span className="sb-chat-actions">
          <button className="sb-act-btn" onClick={handleSave} title="Сохранить"><Check /></button>
          <button className="sb-act-btn" onClick={handleCancel} title="Отмена"><X /></button>
        </span>
      ) : (hovered || active) ? (
        <span className="sb-chat-actions">
          <button className="sb-act-btn" onClick={handleStartEdit} title="Переименовать"><PencilSimple /></button>
          <button
            className="sb-act-btn sb-act-btn--del"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Удалить"
          ><Trash /></button>
        </span>
      ) : null}
    </div>
  );
}
