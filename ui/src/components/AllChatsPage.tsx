import { useState, useMemo } from "react";
import {
  Trash, PencilSimple, Check, X, MagnifyingGlass, ArrowLeft,
} from "@phosphor-icons/react";
import type { ChatSession } from "../hooks/useChats";

interface AllChatsPageProps {
  sessions: ChatSession[];
  activeId: string;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onBack: () => void;
}

export function AllChatsPage({ sessions, activeId, onSwitch, onDelete, onRename, onBack }: AllChatsPageProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.createdAt - a.createdAt),
    [sessions],
  );

  const filtered = query.trim()
    ? sorted.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
    : sorted;

  const allVisibleSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of filtered) next.delete(s.id);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of filtered) next.add(s.id);
        return next;
      });
    }
  };

  const handleBulkDelete = () => {
    if (selected.size === 0) return;
    const msg = `Удалить ${selected.size} чат(ов)?`;
    if (!confirm(msg)) return;
    for (const id of selected) onDelete(id);
    setSelected(new Set());
  };

  return (
    <div className="allchats">
      <div className="allchats-head">
        <button className="allchats-back" onClick={onBack}>
          <ArrowLeft size={18} /> Все чаты
        </button>
        <div className="allchats-search">
          <MagnifyingGlass size={15} />
          <input
            placeholder="Поиск чатов…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="allchats-bulk">
          <span>Выбрано: {selected.size}</span>
          <button onClick={handleBulkDelete}><Trash /> Удалить выбранные</button>
        </div>
      )}

      <div className="allchats-body">
        <label className="allchats-select-all">
          <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
          <span>Выбрать все</span>
          <span className="allchats-count">{filtered.length}</span>
        </label>

        {filtered.map((s) => (
          <div key={s.id} className="allchats-row">
            <input
              type="checkbox"
              className="allchats-cb"
              checked={selected.has(s.id)}
              onChange={() => toggleSelect(s.id)}
            />
            <AllChatsItem
              session={s}
              active={s.id === activeId}
              onSelect={() => { onSwitch(s.id); }}
              onDelete={() => onDelete(s.id)}
              onRename={(title) => onRename(s.id, title)}
            />
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="allchats-empty">Нет чатов</div>
        )}
      </div>
    </div>
  );
}

/* ── Item ─────────────────────────────────── */

function AllChatsItem({
  session, active, onSelect, onDelete, onRename,
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
      className={`allchats-item${active ? " active" : ""}`}
      onClick={editing ? undefined : onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {editing ? (
        <input
          className="allchats-edit"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => setEditing(false)}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="allchats-title">{session.title}</span>
      )}

      {editing ? (
        <span className="allchats-actions">
          <button className="allchats-act" onClick={handleSave} title="Сохранить"><Check /></button>
          <button className="allchats-act" onClick={handleCancel} title="Отмена"><X /></button>
        </span>
      ) : hasActions ? (
        <span className="allchats-actions">
          <button className="allchats-act" onClick={handleStartEdit} title="Переименовать"><PencilSimple /></button>
          <button
            className="allchats-act allchats-act--del"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Удалить"
          ><Trash /></button>
        </span>
      ) : null}
    </div>
  );
}
