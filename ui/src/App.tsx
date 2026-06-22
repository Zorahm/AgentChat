/** Root application — sidebar, chat, artifacts panel layout. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChats, type AgentChatState } from "./hooks/useChats";
import { Sidebar } from "./components/Sidebar";
import { useAvatar } from "./hooks/useAvatar";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { ChatView } from "./components/Chat/ChatView";
import type { ModelItem } from "./components/Chat/ChatView";
import { ArtifactsSidePanel } from "./components/Artifacts/ArtifactsSidePanel";
import { FilesPanel } from "./components/Artifacts/FilesPanel";
import { ResearchPanel } from "./components/Chat/ResearchPanel";
import { SettingsPanel, type NavTab } from "./components/Settings/SettingsPanel";
import { AllChatsPage } from "./components/AllChatsPage";
import { FilesGalleryPage } from "./components/FilesGalleryPage";
import { ProjectsView } from "./components/Projects/ProjectsView";
import { OnboardingWizard } from "./components/Onboarding/OnboardingWizard";
import { GlobalDropZone } from "./components/GlobalDropZone";
import type { AttachmentInfo } from "./types/chat";
import { API_BASE } from "./utils/apiBase";
import { setNotifySoundEnabled, setNotifySound, playNotificationSound } from "./utils/notify";
import { SettingsContext, type SettingsContextValue } from "./contexts/SettingsContext";
import { useShortcuts, type ShortcutHandlers } from "./hooks/useShortcuts";
import { resolveBindings } from "./shortcuts/registry";
import { i18n } from "./i18n";
import { useTranslation } from "react-i18next";

const PANEL_MIN = 280;
const PANEL_MAX = 1500;
const PANEL_DEFAULT = 600;

export function App() {
  const { t } = useTranslation();
  const chats = useChats();
  // Stable identity (useCallback([]) in the hook) — safe to use inside
  // fetchSettings without re-triggering the settings-fetch effect each render.
  const { setWebSearchDefault, setResearchDefault, setThinkingDefault, setEffortDefault } = chats;
  const [view, setView] = useState<"chat" | "skills" | "settings" | "allchats" | "projects" | "files">("chat");
  const [settingsTab, setSettingsTab] = useState<NavTab>("profile");
  const [model, setModel] = useState("openai/gpt-4o");
  const [models, setModels] = useState<ModelItem[]>([]);
  const [enabledProviders, setEnabledProviders] = useState<Set<string>>(new Set());
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effortLevel, setEffortLevel] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [generalPanelOpen, setGeneralPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [openResearchId, setOpenResearchId] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const { avatarUrl, setAvatarFromFile, clearAvatar } = useAvatar();
  const appUpdate = useAppUpdate();
  const [theme, setTheme] = useState("system");
  const [language, setLanguage] = useState("");
  const [wslWarning, setWslWarning] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({});
  const panelWidthRef = useRef(panelWidth);

  const panelOpen = generalPanelOpen || openFilePath !== null || openResearchId !== null;

  // Close artifact / research panels when switching chats
  useEffect(() => {
    setOpenFilePath(null);
    setOpenResearchId(null);
    setGeneralPanelOpen(false);
  }, [chats.activeId]);

  // Live research call for the open panel — found in the active chat's messages
  // so the panel timeline updates as tool_progress events arrive.
  const openResearchCall = useMemo(() => {
    if (!openResearchId) return null;
    for (const m of chats.messages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.id === openResearchId && tc.research) return tc;
      }
    }
    return null;
  }, [openResearchId, chats.messages]);

  // Don't reserve the panel column for a research call that no longer exists.
  useEffect(() => {
    if (openResearchId && !openResearchCall) setOpenResearchId(null);
  }, [openResearchId, openResearchCall]);

  // Track the mobile breakpoint (mirrors styles/responsive.css). On phones the
  // sidebar becomes an off-canvas drawer, so the desktop collapse state is
  // ignored and we close the drawer whenever we leave mobile.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  // Switching chats from the drawer should also dismiss it.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [chats.activeId]);


  // Listen for "Open" clicks on artifact cards in chat
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (path) {
        setOpenFilePath(path);
        setOpenResearchId(null);
        setGeneralPanelOpen(false);
      }
    };
    window.addEventListener("open-artifact", handler);
    return () => window.removeEventListener("open-artifact", handler);
  }, []);

  // Listen for clicks on research cards — open the research timeline panel.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) {
        setOpenResearchId(id);
        setOpenFilePath(null);
        setGeneralPanelOpen(false);
      }
    };
    window.addEventListener("open-research", handler);
    return () => window.removeEventListener("open-research", handler);
  }, []);

  // While the artifacts panel is open, follow a file the model *starts*
  // writing (a newly-appeared streaming liveFile). Only on first appearance —
  // once it finishes or the user opens something else, their selection stands.
  // Never auto-opens a closed panel; this is the panel's only autonomous move.
  const seenLiveIds = useRef<Set<string>>(new Set());
  const followChatRef = useRef<string | null>(null);
  useEffect(() => {
    // On chat switch, re-baseline against the new chat's live files without
    // snapping — its stream (concurrent chats can stream too) isn't something
    // the user just triggered here, and openFilePath is being cleared anyway.
    if (followChatRef.current !== chats.activeId) {
      followChatRef.current = chats.activeId;
      seenLiveIds.current = new Set(chats.liveFiles.map((f) => f.id));
      return;
    }
    const fresh = chats.liveFiles.find((f) => !f.done && !seenLiveIds.current.has(f.id));
    seenLiveIds.current = new Set(chats.liveFiles.map((f) => f.id));
    if (fresh && openFilePath !== null) setOpenFilePath(fresh.path);
  }, [chats.liveFiles, openFilePath, chats.activeId]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const startX = e.clientX;
    const startW = panelWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // drag left → wider
      const next = Math.max(PANEL_MIN, Math.min(PANEL_MAX, startW + delta));
      panelWidthRef.current = next;
      setPanelWidth(next);
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);

  const fetchSettings = useCallback(async () => {
    try {
      const [settingsRes, modelsRes] = await Promise.all([
        fetch(`${API_BASE}/settings`),
        fetch(`${API_BASE}/models`),
      ]);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        if (data.default_model) setModel(data.default_model);
        if (typeof data.user_name === "string") setUserName(data.user_name);
        if (typeof data.theme === "string") setTheme(data.theme);
        setNotifySoundEnabled(data.notify_sound === true);
        setNotifySound(typeof data.notify_sound_data === "string" ? data.notify_sound_data : null);
        if (typeof data.language === "string") setLanguage(data.language);
        if (typeof data.onboarding_completed === "boolean") {
          setOnboardingDone(data.onboarding_completed);
        } else {
          setOnboardingDone(true);
        }
        if (data.shortcuts && typeof data.shortcuts === "object") {
          setShortcuts(data.shortcuts as Record<string, string>);
        }
        // Mirror the persisted web-search default into useChats so new chats
        // seed from settings (not localStorage) and the toggle survives restart.
        setWebSearchDefault({
          enabled: data.web_search_enabled === true,
          mode: typeof data.web_search_mode === "string" ? data.web_search_mode : "auto",
        });
        setResearchDefault(data.research_enabled === true);
        if (data.providers?.length) {
          const enabled = new Set<string>();
          for (const p of data.providers as Array<{ id: string; enabled: boolean }>) {
            if (p.enabled !== false) enabled.add(p.id);
          }
          setEnabledProviders(enabled);
        }
      }

      if (modelsRes.ok) {
        const data = await modelsRes.json();
        if (data.models?.length) {
          setModels(data.models);
          const current = data.models.find((m: ModelItem & { thinking?: boolean }) => m.id === model);
          if (current) setThinkingEnabled((current as { thinking?: boolean }).thinking !== false);
        }
      }
    } catch { /* use defaults */ }
  }, [model, setWebSearchDefault, setResearchDefault]);

  const updateSettings = useCallback(async (partial: Record<string, unknown>) => {
    try {
      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      await fetchSettings();
    } catch { /* offline */ }
  }, [fetchSettings]);

  // Toggle web search on the active chat AND persist the choice to backend
  // settings, so it sticks across restarts and devices (replaces localStorage).
  const handleWebSearchChange = useCallback(
    (enabled: boolean, mode?: string) => {
      chats.setWebSearch(enabled, mode);
      const patch: Record<string, unknown> = { web_search_enabled: enabled };
      if (mode) patch.web_search_mode = mode;
      void updateSettings(patch);
    },
    [chats, updateSettings],
  );

  // Toggle research on the active chat AND persist the sticky default.
  const handleResearchChange = useCallback(
    (enabled: boolean) => {
      chats.setResearch(enabled);
      void updateSettings({ research_enabled: enabled });
    },
    [chats, updateSettings],
  );

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // Chime when ANY chat's reply finishes (the streaming set shrinks) — including
  // one running in the background. Whether it actually sounds (enabled + window
  // unfocused) is decided inside playNotificationSound.
  const prevStreamingCountRef = useRef(0);
  useEffect(() => {
    const count = chats.streamingIds.size;
    if (count < prevStreamingCountRef.current) playNotificationSound();
    prevStreamingCountRef.current = count;
  }, [chats.streamingIds]);

  useEffect(() => {
    if (localStorage.getItem("agentchat.wslWarnDismissed")) return;
    fetch(`${API_BASE}/wsl/status`)
      .then((r) => r.json())
      .then((d) => { if (d.wsl_available === false) setWslWarning(true); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const current = (models as Array<ModelItem & { thinking?: boolean }>).find((m) => m.id === model);
    if (current) setThinkingEnabled(current.thinking !== false);
  }, [model, models]);

  useEffect(() => {
    const applyTheme = (isDark: boolean) => {
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    };

    if (theme === "dark") { applyTheme(true); return; }
    if (theme === "light") { applyTheme(false); return; }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    applyTheme(mq.matches);
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Apply the persisted language once settings load. An empty value means the
  // user never picked one — keep the OS-locale guess from i18n's detector.
  useEffect(() => {
    if (language && i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [language]);

  const handleNavigate = (v: "chat" | "skills" | "settings" | "allchats" | "projects" | "files") => {
    setMobileNavOpen(false);
    if (v === "skills") {
      setSettingsTab("skills");
      setView("settings");
      setTimeout(fetchSettings, 300);
    } else {
      setView(v);
      if (v === "chat" || v === "settings") setTimeout(fetchSettings, 300);
    }
  };

  // Keep the hook's sticky thinking/effort mirror in step with the composer
  // toggles, so retry / edit / project-chat sends reuse the user's choice
  // instead of falling back to the model's defaults (see useChats).
  useEffect(() => { setThinkingDefault(thinkingEnabled); }, [thinkingEnabled, setThinkingDefault]);
  useEffect(() => { setEffortDefault(effortLevel); }, [effortLevel, setEffortDefault]);

  // Listen for navigation from child components (e.g. model selector "settings" link)
  useEffect(() => {
    const handler = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v === "settings:models") {
        setSettingsTab("models");
        setView("settings");
        setTimeout(fetchSettings, 300);
        return;
      }
      if (v === "settings:terminal") {
        setSettingsTab("terminal");
        setView("settings");
        setTimeout(fetchSettings, 300);
        return;
      }
      if (v === "settings" || v === "skills" || v === "chat" || v === "allchats" || v === "projects" || v === "files") handleNavigate(v);
    };
    window.addEventListener("navigate", handler);
    return () => window.removeEventListener("navigate", handler);
  }, [handleNavigate, fetchSettings]);

  // Handle the "Continue + increase limit" button from the iterations-exhausted card
  const continueCbRef = useRef<(count: number) => void>(() => {});
  continueCbRef.current = (count: number) => {
    const newLimit = count * 2;
    void fetch(`${API_BASE}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_iterations: newLimit }),
    }).then(() => {
      if (view !== "chat") setView("chat");
      chats.sendMessage("Continue", model, [], undefined, thinkingEnabled, effortLevel ?? undefined);
      void fetchSettings();
    }).catch(() => {
      if (view !== "chat") setView("chat");
      chats.sendMessage("Continue", model, [], undefined, thinkingEnabled, effortLevel ?? undefined);
    });
  };
  useEffect(() => {
    const handler = (e: Event) => {
      const { count } = (e as CustomEvent<{ count: number }>).detail;
      continueCbRef.current(count);
    };
    window.addEventListener("iterations-continue", handler);
    return () => window.removeEventListener("iterations-continue", handler);
  }, []);

  const handleSend = (text: string, attachments: AttachmentInfo[], html?: string) => {
    if (view !== "chat") setView("chat");
    chats.sendMessage(text, model, attachments, html, thinkingEnabled, effortLevel ?? undefined);
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    const current = models.find((m) => m.id === newModel);
    if (current) {
      setThinkingEnabled(current.thinking !== false);
      if (current.effort_levels && current.effort_levels.length > 0) {
        setEffortLevel((prev) => prev && current.effort_levels!.includes(prev) ? prev : current.effort_levels![0] ?? null);
      } else {
        setEffortLevel(null);
      }
    }
    void updateSettings({ default_model: newModel });
  };

  const handleSignOut = useCallback(async (deleteChats: boolean) => {
    clearAvatar();
    setUserName("");
    if (deleteChats) {
      for (const s of chats.sessions) chats.deleteChat(s.id);
    }
    await updateSettings({ user_name: "", onboarding_completed: false });
    setOnboardingDone(false);
  }, [clearAvatar, chats, updateSettings]);

  const chatState: AgentChatState = {
    messages: chats.messages,
    isStreaming: chats.isStreaming,
    liveFiles: chats.liveFiles,
    error: chats.error,
  };

  const activeSession = chats.sessions.find((s) => s.id === chats.activeId);
  const chatTitle = activeSession?.title ?? t("app.chatTitle");
  const shortTitle = chatTitle.length > 40 ? chatTitle.slice(0, 38) + "…" : chatTitle;

  const handleToggleFiles = () => {
    if (openFilePath) setOpenFilePath(null);
    setOpenResearchId(null);
    setGeneralPanelOpen((v) => !v);
  };

  // From the Files gallery: open a file's preview, switching chats first when
  // it lives in another chat. The activeId-change effect clears openFilePath,
  // so for a cross-chat open we set the path after that effect has run.
  const openFileFromGallery = (sessionId: string, path: string) => {
    setView("chat");
    setGeneralPanelOpen(false);
    if (sessionId !== chats.activeId) {
      chats.switchChat(sessionId);
      setTimeout(() => setOpenFilePath(path), 60);
    } else {
      setOpenFilePath(path);
    }
  };

  const gotoChatFromGallery = (sessionId: string) => {
    if (sessionId !== chats.activeId) chats.switchChat(sessionId);
    setView("chat");
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  const shortcutBindings = useMemo(() => resolveBindings(shortcuts), [shortcuts]);
  const shortcutHandlers: ShortcutHandlers = {
    new_chat: () => { chats.newChat(); setView("chat"); },
    focus_input: () => {
      setView("chat");
      // Wait for the composer to be mounted/visible before focusing it.
      setTimeout(() => window.dispatchEvent(new CustomEvent("focus-composer")), 50);
    },
    toggle_sidebar: () => {
      if (isMobile) setMobileNavOpen((v) => !v);
      else setSidebarCollapsed((v) => !v);
    },
    open_settings: () => handleNavigate("settings"),
    goto_projects: () => handleNavigate("projects"),
    goto_skills: () => handleNavigate("skills"),
  };
  useShortcuts(shortcutBindings, shortcutHandlers);

  const visibleModels = enabledProviders.size > 0
    ? models.filter((m) => {
        const provider = m.id.split("/")[0] ?? "";
        return enabledProviders.has(provider);
      })
    : models;

  const settingsCtx = useMemo<SettingsContextValue>(() => ({
    model, setModel, theme, language, userName, thinkingEnabled, setThinkingEnabled,
    effortLevel, setEffortLevel,
    enabledProviders, models, onboardingDone, shortcuts, updateSettings, refreshSettings: fetchSettings,
  }), [model, theme, language, userName, thinkingEnabled, effortLevel, enabledProviders, models, onboardingDone, shortcuts, updateSettings, fetchSettings]);

  // On mobile the sidebar is a fixed drawer (not a grid column), so the grid is
  // a single column — responsive.css enforces this; the inline value is just a
  // harmless fallback. On desktop the 3-column grid drives the layout.
  const sideW = sidebarCollapsed ? 44 : 240;
  const rightW = view === "chat" && panelOpen ? panelWidth : 0;
  const gridCols = isMobile ? "1fr" : `${sideW}px 1fr ${rightW}px`;
  const effectiveCollapsed = isMobile ? false : sidebarCollapsed;

  return (
    <SettingsContext.Provider value={settingsCtx}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <GlobalDropZone enabled={view === "chat"} />
      {onboardingDone === false && (
        <OnboardingWizard onComplete={() => { setOnboardingDone(true); fetchSettings(); }} />
      )}
      <div
        className={`app-body${effectiveCollapsed ? " sidebar-collapsed" : ""}`}
        style={{ gridTemplateColumns: gridCols }}
      >
        {isMobile && mobileNavOpen && (
          <div
            className="mobile-drawer-backdrop"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <Sidebar
          sessions={chats.sessions}
          activeId={chats.activeId}
          streamingIds={chats.streamingIds}
          onNew={chats.newChat}
          onSwitch={chats.switchChat}
          onDelete={chats.deleteChat}
          onRename={chats.renameChat}
          onPin={chats.pinChat}
          activeView={view}
          onNavigate={handleNavigate}
          collapsed={effectiveCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          userName={userName}
          avatarUrl={avatarUrl}
          mobileOpen={isMobile && mobileNavOpen}
          update={appUpdate}
        />

        {view === "projects" ? (
          <ProjectsView
            sessions={chats.sessions}
            models={visibleModels}
            model={model}
            onModelChange={handleModelChange}
            thinkingEnabled={thinkingEnabled}
            onThinkingToggle={() => setThinkingEnabled((v) => !v)}
            effortLevel={effortLevel}
            onEffortChange={setEffortLevel}
            onClose={() => handleNavigate("chat")}
            onOpenChat={(id) => { chats.switchChat(id); handleNavigate("chat"); }}
            onStartChat={(pid, text, atts, html, dirSlug) => {
              chats.startProjectChat(pid, text, model, atts, html, dirSlug);
              handleNavigate("chat");
            }}
            onDeleteChat={chats.deleteChat}
          />
        ) : (
          <ChatView
            activeId={chats.activeId}
            state={chatState}
            chatTitle={shortTitle}
            dirSlug={chats.activeDirSlug}
            onSend={handleSend}
            onOpenSidebar={() => setMobileNavOpen(true)}
            onStop={chats.abort}
            onRetry={chats.retry}
            onEdit={chats.editMessage}
            onSwitchVariant={chats.switchVariant}
            branchNodes={chats.branchNodes}
            onToggleFiles={handleToggleFiles}
            models={visibleModels}
            model={model}
            onModelChange={handleModelChange}
            thinkingEnabled={thinkingEnabled}
            onThinkingToggle={() => setThinkingEnabled((v) => !v)}
            effortLevel={effortLevel}
            onEffortChange={setEffortLevel}
            mcpEnabled={chats.activeMcpEnabled}
            onToggleMcpServer={chats.toggleMcpServer}
            webSearchEnabled={chats.activeWebSearchEnabled}
            webSearchMode={chats.activeWebSearchMode}
            onWebSearchChange={handleWebSearchChange}
            researchEnabled={chats.activeResearchEnabled}
            onResearchChange={handleResearchChange}
          />
        )}
        {view === "chat" && generalPanelOpen && !openFilePath && !openResearchId && (
          <FilesPanel
            messages={chats.messages}
            onOpenFile={(path) => {
              setGeneralPanelOpen(false);
              setOpenFilePath(path);
            }}
            onClose={() => setGeneralPanelOpen(false)}
          />
        )}
        {view === "chat" && openResearchId && openResearchCall && (
          <ResearchPanel
            key={openResearchId}
            call={openResearchCall}
            onClose={() => setOpenResearchId(null)}
            onResizeStart={handleResizeStart}
          />
        )}
        {view === "chat" && openFilePath && (
          <ArtifactsSidePanel
            key={chats.activeId}
            messages={chats.messages}
            liveFiles={chats.liveFiles}
            openFilePath={openFilePath}
            onClose={() => { setOpenFilePath(null); }}
            onResizeStart={handleResizeStart}
          />
        )}
      </div>

      {view === "allchats" && (
        <div className="ac-modal-overlay" onClick={() => handleNavigate("chat")}>
          <div className="ac-modal-content" onClick={e => e.stopPropagation()}>
            <AllChatsPage
              sessions={chats.sessions}
              activeId={chats.activeId}
              onSwitch={chats.switchChat}
              onDelete={chats.deleteChat}
              onRename={chats.renameChat}
              onPin={chats.pinChat}
              onBack={() => handleNavigate("chat")}
            />
          </div>
        </div>
      )}
      {view === "files" && (
        <div className="ac-modal-overlay" onClick={() => handleNavigate("chat")}>
          <div className="ac-modal-content" onClick={e => e.stopPropagation()}>
            <FilesGalleryPage
              sessions={chats.sessions}
              onOpenFile={openFileFromGallery}
              onGotoChat={gotoChatFromGallery}
              onBack={() => handleNavigate("chat")}
            />
          </div>
        </div>
      )}
      {view === "settings" && (
        <div className="page-overlay">
          <SettingsPanel
            onClose={() => handleNavigate("chat")}
            initialTab={settingsTab}
            avatarUrl={avatarUrl}
            setAvatarFromFile={setAvatarFromFile}
            clearAvatar={clearAvatar}
            onSignOut={handleSignOut}
            onOpenOnboarding={() => { setView("chat"); setOnboardingDone(false); }}
            onStartGhostChat={() => {
              handleNavigate("chat");
              chats.startGhostChat();
            }}
          />
        </div>
      )}
      {wslWarning && (
        <div
          style={{
            position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
            background: "var(--color-surface-2, #2a2a2a)", color: "var(--color-text, #fff)",
            border: "1px solid var(--color-border, #444)", borderRadius: 8,
            padding: "10px 18px", fontSize: 13, zIndex: 9999,
            display: "flex", alignItems: "center", gap: 12, boxShadow: "0 4px 20px rgba(0,0,0,.4)"
          }}
        >
          <span>⚠ {t("app.wslNotFound")}</span>
          <button
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
            onClick={() => { localStorage.setItem("agentchat.wslWarnDismissed", "1"); setWslWarning(false); }}
          >
            ×
          </button>
        </div>
      )}
    </div>
    </SettingsContext.Provider>
  );
}
