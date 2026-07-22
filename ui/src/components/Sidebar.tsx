import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Check, X, Books, Plus, Gear, PushPin, PencilSimple, Trash, MagnifyingGlass, FolderOpen, CaretRight, CloudArrowDown, WarningCircle, ChartBar } from "@phosphor-icons/react";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Avatar } from "@astryxdesign/core/Avatar";
import { ContextMenu, ContextMenuItem } from "@astryxdesign/core/ContextMenu";
import { Divider } from "@astryxdesign/core/Divider";
import type { ChatSession } from "../hooks/useChats";
import type { AppUpdate } from "../hooks/useAppUpdate";
import { GhostChat } from "./GhostChat";
import { useTranslation } from "react-i18next";

interface SidebarProps {
  sessions: ChatSession[];
  activeId: string;
  /** Chats with a stream in flight — shows a "working" dot on the row. */
  streamingIds: ReadonlySet<string>;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  activeView: "chat" | "skills" | "settings" | "library" | "projects" | "usage";
  onNavigate: (view: "chat" | "skills" | "settings" | "library" | "projects" | "usage") => void;
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
  sessions, activeId, streamingIds, onNew, onSwitch, onDelete, onRename, onPin,
  activeView, onNavigate, collapsed, onToggle, userName, avatarUrl,
  update,
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

  const renderChatItem = (s: ChatSession) => (
    <ChatItem
      key={s.id}
      session={s}
      active={s.id === activeId}
      streaming={streamingIds.has(s.id)}
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
  );

  return (
    <>
      <SideNav
        collapsible={{
          isCollapsed: collapsed,
          onCollapsedChange: () => onToggle(),
          hasButton: true,
          buttonLabel: collapsed ? t("sidebar.expand") : t("sidebar.collapse"),
        }}
        header={
          <SideNavHeading
            heading={t("sidebar.appName")}
            icon={
              <span
                className={`sb-logo-wrap${logoDetached ? " sb-logo--detached" : ""}${isPatched ? " sb-logo--patched" : ""}`}
                onClick={handleLogoClick}
                style={{ cursor: isPatched || logoDetached ? "default" : "pointer" }}
              >
                <img className="sb-logo-mark" src="/dots.svg" alt={t("sidebar.appName")} />
                {isPatched && <span className="sb-logo-patch" aria-hidden>🩹</span>}
              </span>
            }
            headerEndContent={
              logoDetached && !isPatched ? (
                <button className="sb-ghost-plus" onClick={() => setGhostOpen(true)} title={t("sidebar.ghostWaiting")}>
                  +
                </button>
              ) : undefined
            }
          />
        }
        topContent={
          <Button
            variant="primary"
            label={t("sidebar.newChat")}
            icon={<Plus weight="bold" />}
            isIconOnly={collapsed}
            width={collapsed ? undefined : "100%"}
            onClick={() => onNew()}
          />
        }
        footer={
          collapsed ? undefined : (
            <div className="sb-user" onClick={() => onNavigate("settings")}>
              <Avatar src={avatarUrl ?? undefined} name={userName || undefined} size={32} />
              <div className="sb-user-info">
                <span className="sb-user-name">{userName || t("sidebar.userFallback")}</span>
                <span className="sb-user-hint">{t("sidebar.settingsHint")}</span>
              </div>
              <span className="sb-user-gear"><Gear /></span>
            </div>
          )
        }
      >
        <SideNavSection title={t("sidebar.navigation")} isHeaderHidden>
          <SideNavItem
            label={t("sidebar.searchTooltip")}
            icon={MagnifyingGlass}
            isSelected={activeView === "library"}
            onClick={() => onNavigate("library")}
          />
          <SideNavItem
            label={t("sidebar.projectsButton")}
            icon={FolderOpen}
            isSelected={activeView === "projects"}
            onClick={() => onNavigate("projects")}
          />
          <SideNavItem
            label={t("sidebar.skillsButton")}
            icon={Books}
            isSelected={activeView === "skills"}
            onClick={() => onNavigate("skills")}
          />
          <SideNavItem
            label={t("sidebar.usageButton")}
            icon={ChartBar}
            isSelected={activeView === "usage"}
            onClick={() => onNavigate("usage")}
          />
        </SideNavSection>

        {!collapsed && (
          <div className="sb-groups">
            {pinned.length > 0 && (
              <SidebarGroup
                label={t("sidebar.pinned")}
                count={pinned.length}
                storageKey="aic-grp-pinned-v1"
                defaultOpen
              >
                {pinned.map(renderChatItem)}
              </SidebarGroup>
            )}

            <SidebarGroup
              label={t("sidebar.recent")}
              count={recent.length}
              storageKey="aic-grp-recent-v1"
              defaultOpen
            >
              {recent.length > 0
                ? recent.map(renderChatItem)
                : <p className="sb-group-empty">{t("sidebar.recentEmpty")}</p>}
            </SidebarGroup>
          </div>
        )}

        {update?.visible && !collapsed && <UpdateBanner update={update} />}
      </SideNav>

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
    </>
  );
}

/* ── Update Banner (expanded sidebar) ───────────────────────────────────── */

export function UpdateBanner({ update }: { update: AppUpdate }) {
  const { t } = useTranslation();
  const { status, busy, install, dismiss } = update;

  if (status.state === "downloading") {
    return (
      <div className="sb-update sb-update--busy">
        <div className="sb-update-head">
          <Spinner size="sm" />
          <span>{t("sidebar.updateDownloading", { progress: status.progress })}</span>
        </div>
        <ProgressBar
          label={t("sidebar.updateDownloading", { progress: status.progress })}
          isLabelHidden
          value={status.progress}
          variant="accent"
        />
      </div>
    );
  }

  if (status.state === "installing") {
    return (
      <div className="sb-update sb-update--busy">
        <div className="sb-update-head">
          <Spinner size="sm" />
          <span>{t("sidebar.updateInstalling")}</span>
        </div>
        <ProgressBar label={t("sidebar.updateInstalling")} isLabelHidden isIndeterminate variant="accent" />
      </div>
    );
  }

  if (status.state === "error") {
    return (
      <div className="sb-update sb-update--error">
        <span className="sb-update-x">
          <IconButton size="sm" variant="ghost" icon={<X />} label={t("sidebar.updateLater")} onClick={dismiss} />
        </span>
        <div className="sb-update-head">
          <WarningCircle />
          <span>{t("sidebar.updateFailed")}</span>
        </div>
        <div className="sb-update-msg">{status.message}</div>
        <div className="sb-update-actions">
          <Button variant="primary" size="sm" label={t("sidebar.updateRetry")} onClick={() => void install()} />
        </div>
      </div>
    );
  }

  if (status.state !== "available") return null;

  return (
    <div className="sb-update sb-update--available">
      <span className="sb-update-x">
        <IconButton
          size="sm"
          variant="ghost"
          icon={<X />}
          label={t("sidebar.updateLater")}
          onClick={dismiss}
          isDisabled={busy}
        />
      </span>
      <div className="sb-update-head">
        <CloudArrowDown />
        <span>{t("sidebar.updateAvailable", { version: status.version })}</span>
      </div>
      <div className="sb-update-actions">
        <Button
          variant="primary"
          size="sm"
          label={t("sidebar.updateRestart")}
          onClick={() => void install()}
          isDisabled={busy}
        />
      </div>
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
  streaming,
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
  streaming?: boolean;
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
  const [isPinning, setIsPinning] = useState(false);

  const handleSelect = useCallback(() => {
    if (editing) return;
    onSelect();
  }, [editing, onSelect]);

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
    <ContextMenu
      isDisabled={editing}
      label={session.title}
      menuContent={
        <>
          <ContextMenuItem
            icon={<PushPin weight={session.pinned ? "fill" : "regular"} />}
            label={session.pinned ? t("sidebar.unpin") : t("sidebar.pin")}
            onClick={handlePin}
          />
          <ContextMenuItem
            icon={<PencilSimple />}
            label={t("sidebar.rename")}
            onClick={handleStartEdit}
          />
          <Divider />
          <ContextMenuItem
            icon={<Trash />}
            label={t("sidebar.delete")}
            onClick={onDelete}
            className="ctx-item--danger"
          />
        </>
      }
    >
      <div
        className={`sb-chat-item${active ? " active" : ""}${session.pinned ? " is-pinned" : ""}${isPinning ? " is-pinning" : ""}${isDragOver ? " is-drag-over" : ""}`}
        onClick={editing ? undefined : handleSelect}
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
              {streaming && <span className="sb-stream-dot" title={t("sidebar.working")} />}
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
    </ContextMenu>
  );
}

/* ── Sidebar collapsible group (Pinned / Recents) ───────────────────────── */

function SidebarGroup({
  label, count, storageKey, defaultOpen = true, children,
}: {
  label: string;
  count: number;
  storageKey: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? defaultOpen : raw === "1";
  });

  const toggle = useCallback(() => {
    setOpen((o) => {
      localStorage.setItem(storageKey, o ? "0" : "1");
      return !o;
    });
  }, [storageKey]);

  return (
    <div className={`sb-group${open ? " is-open" : ""}`}>
      <button className="sb-group-head" onClick={toggle}>
        <CaretRight className="sb-group-caret" size={11} weight="bold" />
        <span className="sb-group-label">{label}</span>
        <span className="sb-group-count">{count}</span>
      </button>
      {open && <div className="sb-group-body">{children}</div>}
    </div>
  );
}
