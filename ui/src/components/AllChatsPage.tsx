import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  Trash, PencilSimple, Check, X, MagnifyingGlass, ArrowLeft,
  PushPin, Chats, SortAscending, SortDescending,
} from "@phosphor-icons/react";
import type { ChatSession, ChatNode } from "../types/chat";
import { useLongPress } from "../hooks/useLongPress";
import { useTranslation } from "react-i18next";

interface AllChatsPageProps {
  sessions: ChatSession[];
  activeId: string;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onBack: () => void;
}

type SortMode = "newest" | "oldest" | "alpha";

function getMessageCount(root: ChatNode[]): number {
  let count = 0;
  function walk(nodes: ChatNode[]) {
    for (const node of nodes) {
      count++;
      if (node.role === "user") {
        for (const uv of node.variants) {
          if (uv.child) walk([uv.child]);
        }
      } else {
        for (const v of node.variants) {
          if (v.children?.length) walk(v.children);
        }
      }
    }
  }
  walk(root);
  return count;
}

function formatDate(ts: number, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return t ? t("allChats.today") : "Сегодня";
  if (days === 1) return t ? t("allChats.yesterday") : "Вчера";
  if (days < 7) return t ? t("allChats.daysAgo", { count: days }) : `${days} дн. назад`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
  } catch {
    return "";
  }
}

export function AllChatsPage({
  sessions, activeId, onSwitch, onDelete, onRename, onPin, onBack,
}: AllChatsPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const sorted = useMemo(() => {
    const arr = [...sessions];
    if (sort === "newest") arr.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === "oldest") arr.sort((a, b) => a.createdAt - b.createdAt);
    else arr.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    return arr;
  }, [sessions, sort]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((s) => s.title.toLowerCase().includes(q)) : sorted;
  }, [sorted, query]);

  const pinned = useMemo(() => filtered.filter((s) => s.pinned), [filtered]);
  const unpinned = useMemo(() => filtered.filter((s) => !s.pinned), [filtered]);

  const allSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.id));

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((s) => s.id)));
  }, [allSelected, filtered]);

  const handleBulkDelete = useCallback(() => {
    if (selected.size === 0) return;
    if (!confirm(t("allChats.deleteConfirm", { count: selected.size }))) return;
    for (const id of selected) onDelete(id);
    setSelected(new Set());
    setSelectMode(false);
  }, [selected, onDelete]);

  const handleExitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const cycleSortMode = useCallback(() => {
    setSort((s) => s === "newest" ? "oldest" : s === "oldest" ? "alpha" : "newest");
  }, []);

  const sortLabel: Record<SortMode, string> = {
    newest: t("allChats.sortNew"),
    oldest: t("allChats.sortOld"),
    alpha: t("allChats.sortAlpha"),
  };

  return (
    <div className="ac-page">
      {/* ── Header ── */}
      <div className="ac-head">
        <button className="ac-back" onClick={onBack} title={t("allChats.cancel")}>
          <ArrowLeft size={18} weight="bold" />
        </button>
        <div className="ac-head-titles">
          <h2 className="ac-head-title">{t("allChats.title")}</h2>
          <span className="ac-head-count">{sessions.length}</span>
        </div>
        <div className="ac-search">
          <MagnifyingGlass size={14} className="ac-search-icon" />
          <input
            ref={searchRef}
            placeholder={t("allChats.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="ac-search-clear" onClick={() => setQuery("")}>
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
        <div className="ac-head-actions">
          <button className="ac-toolbar-btn" onClick={cycleSortMode} title={t("allChats.sortTooltip")}>
            {sort === "oldest" ? <SortAscending size={15} weight="bold" /> : <SortDescending size={15} weight="bold" />}
            <span>{sortLabel[sort]}</span>
          </button>
          {selectMode ? (
            <button className="ac-toolbar-btn ac-toolbar-btn--active" onClick={handleExitSelect}>
              <X size={14} weight="bold" />
              <span>{t("allChats.cancel")}</span>
            </button>
          ) : (
            <button className="ac-toolbar-btn" onClick={() => setSelectMode(true)}>
              <Check size={14} weight="bold" />
              <span>{t("allChats.select")}</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Bulk bar (visible only in select mode with selections) ── */}
      {selectMode && (
        <div className="ac-bulk-bar">
          <label className="ac-bulk-check">
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
            <span>{allSelected ? t("allChats.deselectAll") : t("allChats.selectAll")}</span>
          </label>
          {selected.size > 0 && (
            <div className="ac-bulk-right">
              <span className="ac-bulk-count">{t("allChats.selected", { count: selected.size })}</span>
              <button className="ac-bulk-del" onClick={handleBulkDelete}>
                <Trash size={14} weight="bold" />
                {t("allChats.delete")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Grid ── */}
      <div className="ac-scroll">
        {filtered.length === 0 ? (
          <div className="ac-empty">
            <div className="ac-empty-icon"><Chats size={40} weight="duotone" /></div>
            <p className="ac-empty-title">{t("allChats.emptyTitle")}</p>
            <p className="ac-empty-sub">{t("allChats.emptySubtitle")}</p>
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <section className="ac-section">
                <div className="ac-section-label">
                  <PushPin size={11} weight="fill" />
                  {t("allChats.pinned")}
                </div>
                <div className="ac-grid">
                  {pinned.map((s) => (
                    <ChatCard
                      key={s.id}
                      session={s}
                      active={s.id === activeId}
                      selectMode={selectMode}
                      selected={selected.has(s.id)}
                      onToggleSelect={() => toggleSelect(s.id)}
                      onSelect={() => { onSwitch(s.id); onBack(); }}
                      onDelete={() => onDelete(s.id)}
                      onRename={(t) => onRename(s.id, t)}
                      onPin={() => onPin(s.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {unpinned.length > 0 && (
              <section className="ac-section">
                {pinned.length > 0 && (
                  <div className="ac-section-label">{t("allChats.others")}</div>
                )}
                <div className="ac-grid">
                  {unpinned.map((s) => (
                    <ChatCard
                      key={s.id}
                      session={s}
                      active={s.id === activeId}
                      selectMode={selectMode}
                      selected={selected.has(s.id)}
                      onToggleSelect={() => toggleSelect(s.id)}
                      onSelect={() => { onSwitch(s.id); onBack(); }}
                      onDelete={() => onDelete(s.id)}
                      onRename={(t) => onRename(s.id, t)}
                      onPin={() => onPin(s.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Context Menu ─────────────────────────────────────────────────────────── */

interface CardMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function CardMenu({ x, y, pinned, onPin, onRename, onDelete, onClose }: CardMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // pointerdown covers both mouse and touch dismissals.
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx-menu" style={{ position: "fixed", top: y, left: x, zIndex: 9999 }}>
      <button className="ctx-item" onClick={() => { onPin(); onClose(); }}>
        <PushPin weight={pinned ? "fill" : "regular"} />
        {pinned ? t("allChats.unpin") : t("allChats.pin")}
      </button>
      <button className="ctx-item" onClick={() => { onRename(); onClose(); }}>
        <PencilSimple />
        {t("allChats.rename")}
      </button>
      <div className="ctx-divider" />
      <button className="ctx-item ctx-item--danger" onClick={() => { onDelete(); onClose(); }}>
        <Trash />
        {t("allChats.delete")}
      </button>
    </div>
  );
}

/* ── Chat Card ────────────────────────────────────────────────────────────── */

interface ChatCardProps {
  session: ChatSession;
  active: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onPin: () => void;
}

function ChatCard({
  session, active, selectMode, selected, onToggleSelect, onSelect, onDelete, onRename, onPin,
}: ChatCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const msgCount = useMemo(() => getMessageCount(session.root ?? []), [session.root]);

  // Right-click (desktop) or long-press (touch) opens the context menu.
  const { bind: longPress, shouldSuppressClick } = useLongPress((x, y) => setMenu({ x, y }));

  const handleClick = useCallback(() => {
    if (editing) return;
    if (shouldSuppressClick()) return;
    if (selectMode) { onToggleSelect(); return; }
    onSelect();
  }, [editing, shouldSuppressClick, selectMode, onToggleSelect, onSelect]);

  const handleStartEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(session.title);
    setEditing(true);
  }, [session.title]);

  const handleSave = useCallback((e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    const t = editTitle.trim();
    if (t && t !== session.title) onRename(t);
    setEditing(false);
  }, [editTitle, session.title, onRename]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave(e);
    if (e.key === "Escape") setEditing(false);
  }, [handleSave]);

  return (
    <>
      <div
        className={[
          "ac-card",
          active ? "ac-card--active" : "",
          selected ? "ac-card--selected" : "",
        ].filter(Boolean).join(" ")}
        onClick={handleClick}
        {...longPress}
      >
        {/* Top row */}
        <div className="ac-card-top">
          {selectMode && (
            <input
              type="checkbox"
              className="ac-card-check"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <div className="ac-card-badges">
            {active && <span className="ac-badge ac-badge--active">{t("allChats.currentBadge")}</span>}
            {session.pinned && <span className="ac-badge ac-badge--pin"><PushPin size={9} weight="fill" /></span>}
          </div>
          {!selectMode && !editing && (
            <div className="ac-card-actions" onClick={(e) => e.stopPropagation()}>
              <button className="ac-card-btn" onClick={handleStartEdit} title={t("allChats.renameTooltip")}>
                <PencilSimple size={13} />
              </button>
              <button className="ac-card-btn ac-card-btn--del" onClick={() => onDelete()} title={t("allChats.deleteTooltip")}>
                <Trash size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Title */}
        <div className="ac-card-body">
          {editing ? (
            <div className="ac-card-edit-wrap" onClick={(e) => e.stopPropagation()}>
              <input
                className="ac-card-edit"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKey}
                onBlur={() => setEditing(false)}
                autoFocus
              />
              <div className="ac-card-edit-actions">
                <button className="ac-card-btn ac-card-btn--ok" onMouseDown={(e) => { e.preventDefault(); handleSave(e); }}>
                  <Check size={13} weight="bold" />
                </button>
                <button className="ac-card-btn" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(false); }}>
                  <X size={13} weight="bold" />
                </button>
              </div>
            </div>
          ) : (
            <p className="ac-card-title">{session.title}</p>
          )}
        </div>

        {/* Meta */}
        <div className="ac-card-meta">
          <span className="ac-card-meta-item">
            {msgCount > 0 ? t("allChats.messageCount", { count: msgCount }) : t("allChats.empty")}
          </span>
          <span className="ac-card-meta-sep" />
          <span className="ac-card-meta-item ac-card-meta-date">
            {formatDate(session.createdAt, t)}
            <span className="ac-card-meta-time">{formatTime(session.createdAt)}</span>
          </span>
        </div>
      </div>

      {menu && (
        <CardMenu
          x={menu.x}
          y={menu.y}
          pinned={!!session.pinned}
          onPin={onPin}
          onRename={() => { setEditTitle(session.title); setEditing(true); }}
          onDelete={onDelete}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
