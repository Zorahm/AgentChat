import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Check, X, Books, Plus, Gear, PushPin, PencilSimple, Trash, MagnifyingGlass, FolderOpen, Images, ArrowClockwise, CloudArrowDown, WarningCircle } from "@phosphor-icons/react";
import type { ChatSession } from "../hooks/useChats";
import type { AppUpdate } from "../hooks/useAppUpdate";
import { useLongPress } from "../hooks/useLongPress";
import { GhostChat } from "./GhostChat";
import { useTranslation } from "react-i18next";

interface SidebarProps {
  sessions: ChatSession[];
  activeId: string;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  activeView: "chat" | "skills" | "settings" | "allchats" | "projects" | "files";
  onNavigate: (view: "chat" | "skills" | "settings" | "allchats" | "projects" | "files") => void;
  collapsed: boolean;
  onToggle: () => void;
  userName: string;
  avatarUrl: string | null;
  /** Mobile only: when true the sidebar slides in as an off-canvas drawer. */
  mobileOpen?: boolean;
  /** Desktop auto-update banner state (absent in the browser/dev build). */
  update?: AppUpdate;
}

const RECENT_LIMIT = 15;

export function Sidebar({
  sessions, activeId, onNew, onSwitch, onDelete, onRename, onPin,
  activeView, onNavigate, collapsed, onToggle, userName, avatarUrl,
  mobileOpen = false, update,
}: SidebarProps) {
  const { t } = useTranslation();
  const [orderIds, setOrderIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("aic-chat-order-v1");
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  });

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{
    draggedId: string;
    targetId: string;
    type: "pin" | "unpin";
  } | null>(null);

  // ── Easter egg ─────────────────────────────────────────────────────────────
  const [isPatched, setIsPatched] = useState(() => localStorage.getItem("aic-ghost-patched-v1") === "1");
  const [logoDetached, setLogoDetached] = useState(false);
  const [ghostOpen, setGhostOpen] = useState(false);
  const logoClickTimesRef = useRef<number[]>([]);

  const handleLogoClick = useCallback(() => {
    if (isPatched || logoDetached) return;
    const now = Date.now();
    logoClickTimesRef.current = [...logoClickTimesRef.current, now].filter(t => now - t < 2500);
    if (logoClickTimesRef.current.length >= 7) {
      logoClickTimesRef.current = [];
      setLogoDetached(true);
    }
  }, [isPatched, logoDetached]);

  const handleGhostClose = useCallback(() => {
    setGhostOpen(false);
    setLogoDetached(false);
    localStorage.setItem("aic-ghost-patched-v1", "1");
    setIsPatched(true);
  }, []);

  const saveOrder = useCallback((newOrder: string[]) => {
    setOrderIds(newOrder);
    localStorage.setItem("aic-chat-order-v1", JSON.stringify(newOrder));
  }, []);

  // All chats show in the sidebar; project chats are marked with a folder glyph.
  const standalone = useMemo(() => sessions, [sessions]);

  const pinned = useMemo(() => {
    const p = standalone.filter(s => s.pinned);
    p.sort((a, b) => {
      const idxA = orderIds.indexOf(a.id);
      const idxB = orderIds.indexOf(b.id);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return b.createdAt - a.createdAt;
    });
    return p;
  }, [standalone, orderIds]);

  const recent = useMemo(() => {
    const r = standalone.filter(s => !s.pinned);
    r.sort((a, b) => {
      const idxA = orderIds.indexOf(a.id);
      const idxB = orderIds.indexOf(b.id);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return b.createdAt - a.createdAt;
    });
    return r.slice(0, RECENT_LIMIT);
  }, [standalone, orderIds]);

  const allDisplayed = useMemo(() => [...pinned, ...recent], [pinned, recent]);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (id !== dragOverId) setDragOverId(id);
  }, [dragOverId]);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const executeDrop = useCallback((dragId: string, tgtId: string, togglePin: boolean) => {
    let currentOrder = [...orderIds];
    const allIds = allDisplayed.map(s => s.id);
    for (const id of allIds) {
      if (!currentOrder.includes(id)) currentOrder.push(id);
    }
    const draggedIdx = currentOrder.indexOf(dragId);
    const targetIdx = currentOrder.indexOf(tgtId);

    if (draggedIdx !== -1 && targetIdx !== -1) {
      const newOrder = [...currentOrder];
      const [removed] = newOrder.splice(draggedIdx, 1);
      if (removed !== undefined) {
        newOrder.splice(targetIdx, 0, removed);
        saveOrder(newOrder);
      }
      
      if (togglePin) {
         onPin(dragId);
      }
    }
  }, [orderIds, allDisplayed, saveOrder, onPin]);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    if (!draggedId || draggedId === targetId) return;

    let currentOrder = [...orderIds];
    const allIds = allDisplayed.map(s => s.id);
    
    for (const id of allIds) {
      if (!currentOrder.includes(id)) currentOrder.push(id);
    }
    
    const draggedIdx = currentOrder.indexOf(draggedId);
    const targetIdx = currentOrder.indexOf(targetId);
    
    if (draggedIdx !== -1 && targetIdx !== -1) {
      const draggedSession = sessions.find(s => s.id === draggedId);
      const targetSession = sessions.find(s => s.id === targetId);
      
      if (draggedSession && targetSession && draggedSession.pinned !== targetSession.pinned) {
         if (draggedSession.pinned && !targetSession.pinned) {
            setPendingDrop({ draggedId, targetId, type: "unpin" });
            return;
         } else if (!draggedSession.pinned && targetSession.pinned) {
            setPendingDrop({ draggedId, targetId, type: "pin" });
            return;
         }
      }

      executeDrop(draggedId, targetId, false);
    }
  }, [draggedId, orderIds, allDisplayed, sessions, executeDrop]);

  if (collapsed) {
    const hasPinned = pinned.length > 0;
    const hasRecent = recent.length > 0;

    return (
      <aside className="sidebar sidebar--collapsed">
        {/* Toggle */}
        <button className="sb-col-toggle" onClick={onToggle} title={t("sidebar.expand")}>
          ☰
        </button>

        {/* New chat */}
        <button className="sb-col-new" onClick={() => onNew()} title={t("sidebar.newChat")}>
          <Plus weight="bold" size={15} />
        </button>

        {/* Search */}
        <button className="sb-col-search" onClick={() => onNavigate("allchats")} title={t("sidebar.search")}>
          <MagnifyingGlass size={15} weight="bold" />
        </button>

        {/* Files */}
        <button className="sb-col-search" onClick={() => onNavigate("files")} title={t("sidebar.filesTooltip")}>
          <Images size={15} weight="bold" />
        </button>

        {/* Chat chips */}
        <div className="sb-col-list">
          {hasPinned && (
            <div className="sb-col-chips">
              {pinned.map((s) => (
                <ChatChip
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  isDragOver={dragOverId === s.id}
                  onSelect={() => { onSwitch(s.id); onNavigate("chat"); }}
                  onDragStart={(e) => handleDragStart(e, s.id)}
                  onDragOver={(e) => handleDragOver(e, s.id)}
                  onDrop={(e) => handleDrop(e, s.id)}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>
          )}

          {hasPinned && hasRecent && <div className="sb-col-divider" />}

          {hasRecent && (
            <div className="sb-col-chips">
              {recent.slice(0, 8).map((s) => (
                <ChatChip
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  isDragOver={dragOverId === s.id}
                  onSelect={() => { onSwitch(s.id); onNavigate("chat"); }}
                  onDragStart={(e) => handleDragStart(e, s.id)}
                  onDragOver={(e) => handleDragOver(e, s.id)}
                  onDrop={(e) => handleDrop(e, s.id)}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>
          )}
        </div>

        {/* Update chip */}
        {update?.visible && <UpdateChip update={update} />}

        {/* Bottom nav */}
        <nav className="sb-col-foot">
          <button
            className={`sb-col-btn${activeView === "skills" ? " sb-col-btn--active" : ""}`}
            onClick={() => onNavigate("skills")}
            title={t("sidebar.skills")}
          >
            <Books size={16} />
          </button>
          <button
            className={`sb-col-btn${activeView === "projects" ? " sb-col-btn--active" : ""}`}
            onClick={() => onNavigate("projects")}
            title={t("sidebar.projects")}
          >
            <FolderOpen size={16} />
          </button>
          <button
            className={`sb-col-btn${activeView === "settings" ? " sb-col-btn--active" : ""}`}
            onClick={() => onNavigate("settings")}
            title={t("sidebar.settings")}
          >
            <Gear size={16} />
          </button>
          <button
            className="sb-col-avatar"
            onClick={() => onNavigate("settings")}
            title={userName || t("sidebar.profile")}
          >
            <AvatarCircle url={avatarUrl} name={userName} size={26} />
          </button>
        </nav>

        {pendingDrop && (
          <ConfirmDialog
            title={pendingDrop.type === "unpin" ? t("sidebar.unpinConfirm") : t("sidebar.pinConfirm")}
            message={
               pendingDrop.type === "unpin" 
                 ? t("sidebar.unpinMessage")
                 : t("sidebar.pinMessage")
            }
            onConfirm={() => {
               executeDrop(pendingDrop.draggedId, pendingDrop.targetId, true);
               setPendingDrop(null);
            }}
            onCancel={() => {
               setPendingDrop(null);
            }}
          />
        )}
      </aside>
    );
  }

  return (
    <aside className={`sidebar${mobileOpen ? " sidebar--mobile-open" : ""}`}>
      <div className="sb-top">
        <div className="sb-logo">
          <div
            className={`sb-logo-wrap${logoDetached ? " sb-logo--detached" : ""}${isPatched ? " sb-logo--patched" : ""}`}
            onClick={handleLogoClick}
            style={{ cursor: isPatched || logoDetached ? "default" : "pointer" }}
            title={isPatched ? "" : undefined}
          >
            <img className="sb-logo-mark" src="/dots.svg" alt={t("sidebar.appName")} />
            {isPatched && <span className="sb-logo-patch" aria-hidden>🩹</span>}
          </div>
          <span>{t("sidebar.appName")}</span>
          {logoDetached && !isPatched && (
            <button className="sb-ghost-plus" onClick={() => setGhostOpen(true)} title={t("sidebar.ghostWaiting")}>
              +
            </button>
          )}
        </div>
        <button className="sb-icon-btn sb-hamburger" onClick={onToggle}>☰</button>
      </div>

      <div className="sb-body">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <button className="sb-new-chat" onClick={() => onNew()} style={{ flex: 1, marginBottom: 0 }}>
            <span>{t("sidebar.newChatButton")}</span>
          </button>

          <button
            className="sb-col-search"
            style={{ marginBottom: 0, width: '38px', height: '38px' }}
            onClick={() => onNavigate("allchats")}
            title={t("sidebar.searchTooltip")}
          >
            <MagnifyingGlass size={16} weight="bold" />
          </button>

          <button
            className="sb-col-search"
            style={{ marginBottom: 0, width: '38px', height: '38px' }}
            onClick={() => onNavigate("files")}
            title={t("sidebar.filesTooltip")}
          >
            <Images size={16} weight="bold" />
          </button>
        </div>
        <button className="sb-skills-btn" onClick={() => onNavigate("skills")}>
          <Books />
          <span>{t("sidebar.skillsButton")}</span>
        </button>
        <button
          className={`sb-skills-btn${activeView === "projects" ? " active" : ""}`}
          onClick={() => onNavigate("projects")}
        >
          <FolderOpen />
          <span>{t("sidebar.projectsButton")}</span>
        </button>

        <div className="sb-section-header">
          <span className="sb-section-label">{t("sidebar.recent")}</span>
        </div>

        <div className="sb-list">
          {allDisplayed.map((s) => (
            <ChatItem
              key={s.id}
              session={s}
              active={s.id === activeId}
              isProject={!!s.projectId}
              isDragOver={s.id === dragOverId}
              onSelect={() => { onSwitch(s.id); onNavigate("chat"); }}
              onDelete={() => onDelete(s.id)}
              onRename={(title) => onRename(s.id, title)}
              onPin={() => onPin(s.id)}
              onDragStart={(e) => handleDragStart(e, s.id)}
              onDragOver={(e) => handleDragOver(e, s.id)}
              onDrop={(e) => handleDrop(e, s.id)}
              onDragEnd={handleDragEnd}
            />
          ))}
        </div>


      </div>

      {update?.visible && <UpdateBanner update={update} />}

      <div className="sb-foot">
        <div className="sb-user" onClick={() => onNavigate("settings")}>
          <AvatarCircle url={avatarUrl} name={userName} size={30} />
          <div className="sb-user-info">
            <span className="sb-user-name">{userName || t("sidebar.userFallback")}</span>
            <span className="sb-user-hint">{t("sidebar.settingsHint")}</span>
          </div>
          <span className="sb-user-gear"><Gear /></span>
        </div>
      </div>

      {pendingDrop && (
        <ConfirmDialog
          title={pendingDrop.type === "unpin" ? t("sidebar.unpinConfirm") : t("sidebar.pinConfirm")}
          message={
             pendingDrop.type === "unpin"
               ? t("sidebar.unpinMessage")
               : t("sidebar.pinMessage")
          }
          onConfirm={() => {
             executeDrop(pendingDrop.draggedId, pendingDrop.targetId, true);
             setPendingDrop(null);
          }}
          onCancel={() => {
             setPendingDrop(null);
          }}
        />
      )}

      {ghostOpen && <GhostChat onClose={handleGhostClose} />}
    </aside>
  );
}

/* ── Update Banner (expanded sidebar) ───────────────────────────────────── */

function UpdateBanner({ update }: { update: AppUpdate }) {
  const { t } = useTranslation();
  const { status, busy, install, dismiss } = update;

  if (status.state === "downloading") {
    return (
      <div className="sb-update sb-update--busy">
        <ArrowClockwise className="spin" />
        <span className="sb-update-msg">{t("sidebar.updateDownloading", { progress: status.progress })}</span>
      </div>
    );
  }

  if (status.state === "installing") {
    return (
      <div className="sb-update sb-update--busy">
        <ArrowClockwise className="spin" />
        <span className="sb-update-msg">{t("sidebar.updateInstalling")}</span>
      </div>
    );
  }

  if (status.state === "error") {
    return (
      <div className="sb-update sb-update--error">
        <button className="sb-update-x" onClick={dismiss} title={t("sidebar.updateLater")}><X /></button>
        <div className="sb-update-head">
          <WarningCircle />
          <span>{t("sidebar.updateFailed")}</span>
        </div>
        <div className="sb-update-msg">{status.message}</div>
        <div className="sb-update-actions">
          <button className="sb-update-btn sb-update-btn--primary" onClick={() => void install()}>
            {t("sidebar.updateRetry")}
          </button>
        </div>
      </div>
    );
  }

  if (status.state !== "available") return null;

  return (
    <div className="sb-update sb-update--available">
      <div className="sb-update-head">
        <CloudArrowDown />
        <span>{t("sidebar.updateAvailable", { version: status.version })}</span>
      </div>
      <div className="sb-update-actions">
        <button
          className="sb-update-btn sb-update-btn--primary"
          onClick={() => void install()}
          disabled={busy}
        >
          {t("sidebar.updateRestart")}
        </button>
        <button className="sb-update-btn" onClick={dismiss} disabled={busy}>
          {t("sidebar.updateLater")}
        </button>
      </div>
    </div>
  );
}

/* ── Update Chip (collapsed sidebar) ────────────────────────────────────── */

function UpdateChip({ update }: { update: AppUpdate }) {
  const { t } = useTranslation();
  const { status, busy, install } = update;

  const title =
    status.state === "downloading"
      ? t("sidebar.updateDownloading", { progress: status.progress })
      : status.state === "installing"
        ? t("sidebar.updateInstalling")
        : status.state === "error"
          ? t("sidebar.updateFailed")
          : status.state === "available"
            ? t("sidebar.updateAvailable", { version: status.version })
            : "";

  return (
    <button
      className={`sb-col-update${status.state === "error" ? " sb-col-update--error" : ""}`}
      onClick={() => void install()}
      disabled={busy}
      title={title}
    >
      {status.state === "error" ? (
        <WarningCircle size={16} />
      ) : busy ? (
        <ArrowClockwise size={16} className="spin" />
      ) : (
        <CloudArrowDown size={16} />
      )}
    </button>
  );
}

/* ── Context Menu ───────────────────────────────────────────────────────── */

interface ContextMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function ContextMenu({ x, y, pinned, onPin, onRename, onDelete, onClose }: ContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // pointerdown covers both mouse and touch dismissals.
    document.addEventListener("pointerdown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Adjust so menu doesn't go off screen
  const style: React.CSSProperties = {
    position: "fixed",
    top: y,
    left: x,
    zIndex: 9999,
  };

  return (
    <div ref={ref} className="ctx-menu" style={style}>
      <button
        className="ctx-item"
        onClick={() => { onPin(); onClose(); }}
      >
        <PushPin weight={pinned ? "fill" : "regular"} />
        {pinned ? t("sidebar.unpin") : t("sidebar.pin")}
      </button>
      <button
        className="ctx-item"
        onClick={() => { onRename(); onClose(); }}
      >
        <PencilSimple />
        {t("sidebar.rename")}
      </button>
      <div className="ctx-divider" />
      <button
        className="ctx-item ctx-item--danger"
        onClick={() => { onDelete(); onClose(); }}
      >
        <Trash />
        {t("sidebar.delete")}
      </button>
    </div>
  );
}

/* ── Confirm Dialog ─────────────────────────────────────────────────────── */

function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="confirm-close" onClick={onCancel}>
          <X weight="bold" />
        </button>
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="confirm-btn confirm-btn--cancel" onClick={onCancel}>
            {t("sidebar.cancel")}
          </button>
          <button className="confirm-btn confirm-btn--confirm" onClick={onConfirm}>
            {t("sidebar.confirmYes")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Chat Item ──────────────────────────────────────────────────────────── */

function ChatItem({
  session,
  active,
  isProject,
  isDragOver,
  onSelect,
  onDelete,
  onRename,
  onPin,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  session: ChatSession;
  active: boolean;
  isProject?: boolean;
  isDragOver?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onPin: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [isPinning, setIsPinning] = useState(false);

  // Right-click (desktop) or long-press (touch) opens the context menu.
  const { bind: longPress, shouldSuppressClick } = useLongPress((x, y) => setMenu({ x, y }));

  const handleSelect = useCallback(() => {
    if (editing) return;
    if (shouldSuppressClick()) return;
    onSelect();
  }, [editing, shouldSuppressClick, onSelect]);

  const handlePin = useCallback(() => {
    setIsPinning(true);
    setTimeout(() => {
      onPin();
      setIsPinning(false);
    }, 220);
  }, [onPin]);

  const handleStartEdit = useCallback(() => {
    setEditTitle(session.title);
    setEditing(true);
  }, [session.title]);

  const handleSave = useCallback((e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    const trimmed = editTitle.trim();
    if (trimmed) onRename(trimmed);
    setEditing(false);
  }, [editTitle, onRename]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave(e);
    if (e.key === "Escape") setEditing(false);
  }, [handleSave]);

  return (
    <>
      <div
        className={`sb-chat-item${active ? " active" : ""}${session.pinned ? " is-pinned" : ""}${isPinning ? " is-pinning" : ""}${isDragOver ? " is-drag-over" : ""}`}
        onClick={editing ? undefined : handleSelect}
        {...(editing ? {} : longPress)}
        draggable={!editing}
        onDragStart={!editing ? onDragStart : undefined}
        onDragOver={!editing ? onDragOver : undefined}
        onDrop={!editing ? onDrop : undefined}
        onDragEnd={!editing ? onDragEnd : undefined}
      >
        {editing ? (
          <>
            <input
              className="sb-chat-edit"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleKey}
              onBlur={() => setEditing(false)}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <span className="sb-chat-actions">
              <button
                className="sb-act-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSave(e);
                }}
                title={t("sidebar.save")}
              >
                <Check />
              </button>
              <button
                className="sb-act-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(false);
                }}
                title={t("sidebar.cancel")}
              >
                <X />
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="sb-chat-titlewrap">
              {isProject && (
                <FolderOpen className="sb-chat-proj-icon" weight="duotone" />
              )}
              <span className="sb-chat-title">{session.title}</span>
            </span>
            <button
              className={`sb-pin-btn${session.pinned ? " sb-pin-btn--active" : ""}`}
              onClick={(e) => { e.stopPropagation(); handlePin(); }}
              title={session.pinned ? t("sidebar.unpinTooltip") : t("sidebar.pinTooltip")}
            >
              <PushPin weight={session.pinned ? "fill" : "regular"} />
            </button>
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          pinned={!!session.pinned}
          onPin={handlePin}
          onRename={handleStartEdit}
          onDelete={onDelete}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/* ── ChatChip (collapsed mode) ──────────────────────────────────────────── */

const CHIP_COLORS = [
  "sb-chip--a", "sb-chip--b", "sb-chip--c",
  "sb-chip--d", "sb-chip--e", "sb-chip--f",
];

function getChipColor(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
  return CHIP_COLORS[Math.abs(h) % CHIP_COLORS.length]!;
}

function ChatChip({
  session, active, isDragOver, onSelect,
  onDragStart, onDragOver, onDrop, onDragEnd
}: {
  session: ChatSession;
  active: boolean;
  isDragOver?: boolean;
  onSelect: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const initial = (session.title[0] ?? "?").toUpperCase();
  const color = getChipColor(session.title);
  
  let className = `sb-chip ${color}`;
  if (active) className += " sb-chip--active";
  if (session.pinned) className += " sb-chip--pinned";
  if (isDragOver) className += " sb-chip--drag-over";

  return (
    <button
      className={className}
      onClick={onSelect}
      title={session.title}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {initial}
    </button>
  );
}

/* ── AvatarCircle ───────────────────────────────────────────────────────── */

export function AvatarCircle({ url, name, size = 30 }: {
  url: string | null;
  name: string;
  size?: number;
}) {
  const letter = name ? name[0]!.toUpperCase() : "?";
  return (
    <div
      className="sb-avatar"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {url
        ? <img src={url} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : letter
      }
    </div>
  );
}
