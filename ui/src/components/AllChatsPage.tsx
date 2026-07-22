import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  Trash, PencilSimple, Check, ArrowLeft,
  PushPin, Chats, SortAscending, SortDescending,
} from "@phosphor-icons/react";
import type { ChatSession, ChatNode } from "../types/chat";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { ContextMenu, ContextMenuItem } from "@astryxdesign/core/ContextMenu";
import { Divider } from "@astryxdesign/core/Divider";

interface AllChatsPageProps {
  sessions: ChatSession[];
  activeId: string;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onBack: () => void;
  /** When embedded in the Library page, the standalone header/search is hidden
   *  and the query is controlled from the parent's shared search box. */
  embedded?: boolean;
  query?: string;
  onQueryChange?: (q: string) => void;
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
  embedded = false, query: extQuery, onQueryChange,
}: AllChatsPageProps) {
  const { t } = useTranslation();
  const [internalQuery, setInternalQuery] = useState("");
  const query = extQuery !== undefined ? extQuery : internalQuery;
  const setQuery = onQueryChange ?? setInternalQuery;
  const [sort, setSort] = useState<SortMode>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!embedded) searchRef.current?.focus(); }, [embedded]);

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

  const actions = (
    <div className="ac-head-actions">
      <Button
        variant="ghost"
        size="sm"
        label={sortLabel[sort]}
        icon={sort === "oldest" ? <SortAscending size={15} weight="bold" /> : <SortDescending size={15} weight="bold" />}
        onClick={cycleSortMode}
        tooltip={t("allChats.sortTooltip")}
      />
      {selectMode ? (
        <Button
          variant="ghost"
          size="sm"
          label={t("allChats.cancel")}
          icon={<Check size={14} weight="bold" />}
          onClick={handleExitSelect}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          label={t("allChats.select")}
          icon={<Check size={14} weight="bold" />}
          onClick={() => setSelectMode(true)}
        />
      )}
    </div>
  );

  return (
    <div className={`ac-page${embedded ? " ac-page--embedded" : ""}`}>
      {/* ── Header (standalone only) ── */}
      {!embedded && (
        <div className="ac-head">
          <Button variant="ghost" isIconOnly icon={<ArrowLeft size={18} weight="bold" />} label={t("allChats.cancel")} onClick={onBack} />
          <div className="ac-head-titles">
            <h2 className="ac-head-title">{t("allChats.title")}</h2>
            <span className="ac-head-count">{sessions.length}</span>
          </div>
          <TextInput
            ref={searchRef as React.Ref<HTMLInputElement>}
            label={t("allChats.searchPlaceholder")}
            placeholder={t("allChats.searchPlaceholder")}
            value={query}
            onChange={(value: string) => setQuery(value)}
            isLabelHidden
          />
          {actions}
        </div>
      )}

      {/* ── Embedded toolbar (Library tab) ── */}
      {embedded && (
        <div className="ac-embed-toolbar">
          <span className="ac-head-count">{sessions.length}</span>
          {actions}
        </div>
      )}

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
              <Button
                variant="destructive"
                size="sm"
                label={t("allChats.delete")}
                icon={<Trash size={14} weight="bold" />}
                onClick={handleBulkDelete}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Grid ── */}
      <div className="ac-scroll">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Chats size={40} weight="duotone" />}
            title={t("allChats.emptyTitle")}
            description={t("allChats.emptySubtitle")}
          />
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

  const msgCount = useMemo(() => getMessageCount(session.root ?? []), [session.root]);

  const handleClick = useCallback(() => {
    if (editing) return;
    if (selectMode) { onToggleSelect(); return; }
    onSelect();
  }, [editing, selectMode, onToggleSelect, onSelect]);

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
    <ContextMenu
      isDisabled={editing}
      label={session.title}
      menuContent={
        <>
          <ContextMenuItem
            icon={<PushPin weight={session.pinned ? "fill" : "regular"} />}
            label={session.pinned ? t("allChats.unpin") : t("allChats.pin")}
            onClick={onPin}
          />
          <ContextMenuItem
            icon={<PencilSimple />}
            label={t("allChats.rename")}
            onClick={() => { setEditTitle(session.title); setEditing(true); }}
          />
          <Divider />
          <ContextMenuItem
            icon={<Trash />}
            label={t("allChats.delete")}
            onClick={onDelete}
            className="ctx-item--danger"
          />
        </>
      }
    >
      <div
        className={[
          "ac-card",
          active ? "ac-card--active" : "",
          selected ? "ac-card--selected" : "",
        ].filter(Boolean).join(" ")}
        onClick={handleClick}
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
            {active && <Badge variant="blue" label={t("allChats.currentBadge")} />}
            {session.pinned && <Badge variant="green" icon={<PushPin size={9} weight="fill" />} label="" />}
          </div>
          {!selectMode && !editing && (
            <div className="ac-card-actions" onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="sm" isIconOnly icon={<PencilSimple size={13} />} label={t("allChats.renameTooltip")} onClick={handleStartEdit} tooltip={t("allChats.renameTooltip")} />
              <Button variant="ghost" size="sm" isIconOnly icon={<Trash size={13} />} label={t("allChats.deleteTooltip")} onClick={() => onDelete()} tooltip={t("allChats.deleteTooltip")} />
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
                <Button variant="secondary" size="sm" isIconOnly icon={<Check size={13} weight="bold" />} label="Save" onMouseDown={(e) => { e.preventDefault(); handleSave(e); }} />
                <Button variant="ghost" size="sm" isIconOnly icon={<Check size={13} weight="bold" />} label="Cancel" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(false); }} />
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
    </ContextMenu>
  );
}
