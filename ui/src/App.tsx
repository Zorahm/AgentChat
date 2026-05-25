/** Root application — sidebar, chat, artifacts panel layout. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChats, type AgentChatState } from "./hooks/useChats";
import { Sidebar } from "./components/Sidebar";
import { useAvatar } from "./hooks/useAvatar";
import { ChatView } from "./components/Chat/ChatView";
import type { ModelItem } from "./components/Chat/ChatView";
import { ArtifactsSidePanel } from "./components/Artifacts/ArtifactsSidePanel";
import { FilesPanel } from "./components/Artifacts/FilesPanel";
import { SettingsPanel, type NavTab } from "./components/Settings/SettingsPanel";
import { AllChatsPage } from "./components/AllChatsPage";
import { ProjectsView } from "./components/Projects/ProjectsView";
import { OnboardingWizard } from "./components/Onboarding/OnboardingWizard";
import { GlobalDropZone } from "./components/GlobalDropZone";
import type { AttachmentInfo } from "./types/chat";
import { API_BASE } from "./utils/apiBase";
import { SettingsContext, type SettingsContextValue } from "./contexts/SettingsContext";

const PANEL_MIN = 280;
const PANEL_MAX = 1500;
const PANEL_DEFAULT = 600;

export function App() {
  const chats = useChats();
  const [view, setView] = useState<"chat" | "skills" | "settings" | "allchats" | "projects">("chat");
  const [settingsTab, setSettingsTab] = useState<NavTab>("main");
  const [model, setModel] = useState("openai/gpt-4o");
  const [models, setModels] = useState<ModelItem[]>([]);
  const [enabledProviders, setEnabledProviders] = useState<Set<string>>(new Set());
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [generalPanelOpen, setGeneralPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const { avatarUrl, setAvatarFromFile, clearAvatar } = useAvatar();
  const [theme, setTheme] = useState("system");
  const [wslWarning, setWslWarning] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const panelWidthRef = useRef(panelWidth);

  const panelOpen = generalPanelOpen || openFilePath !== null;

  // Close artifact panel when switching chats
  useEffect(() => {
    setOpenFilePath(null);
    setGeneralPanelOpen(false);
  }, [chats.activeId]);


  // Listen for "Open" clicks on artifact cards in chat
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (path) {
        setOpenFilePath(path);
        setGeneralPanelOpen(false);
      }
    };
    window.addEventListener("open-artifact", handler);
    return () => window.removeEventListener("open-artifact", handler);
  }, []);

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
        if (typeof data.onboarding_completed === "boolean") {
          setOnboardingDone(data.onboarding_completed);
        } else {
          setOnboardingDone(true);
        }
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
  }, [model]);

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

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

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

  const handleNavigate = (v: "chat" | "skills" | "settings" | "allchats" | "projects") => {
    if (v === "skills") {
      setSettingsTab("skills");
      setView("settings");
      setTimeout(fetchSettings, 300);
    } else {
      setView(v);
      if (v === "chat" || v === "settings") setTimeout(fetchSettings, 300);
    }
  };

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
      if (v === "settings" || v === "skills" || v === "chat" || v === "allchats" || v === "projects") handleNavigate(v);
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
      chats.sendMessage("Continue", model, []);
      void fetchSettings();
    }).catch(() => {
      if (view !== "chat") setView("chat");
      chats.sendMessage("Continue", model, []);
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
    chats.sendMessage(text, model, attachments, html);
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    const current = (models as Array<ModelItem & { thinking?: boolean }>).find((m) => m.id === newModel);
    if (current) setThinkingEnabled(current.thinking !== false);
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
  const chatTitle = activeSession?.title ?? "Chat";
  const shortTitle = chatTitle.length > 40 ? chatTitle.slice(0, 38) + "…" : chatTitle;

  const handleToggleFiles = () => {
    if (openFilePath) setOpenFilePath(null);
    setGeneralPanelOpen((v) => !v);
  };

  const visibleModels = enabledProviders.size > 0
    ? models.filter((m) => {
        const provider = m.id.split("/")[0] ?? "";
        return enabledProviders.has(provider);
      })
    : models;

  const settingsCtx = useMemo<SettingsContextValue>(() => ({
    model, setModel, theme, userName, thinkingEnabled, setThinkingEnabled,
    enabledProviders, models, onboardingDone, updateSettings, refreshSettings: fetchSettings,
  }), [model, theme, userName, thinkingEnabled, enabledProviders, models, onboardingDone, updateSettings, fetchSettings]);

  const sideW = sidebarCollapsed ? 44 : 240;
  const rightW = view === "chat" && panelOpen ? panelWidth : 0;
  const gridCols = `${sideW}px 1fr ${rightW}px`;

  return (
    <SettingsContext.Provider value={settingsCtx}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <GlobalDropZone />
      {onboardingDone === false && (
        <OnboardingWizard onComplete={() => { setOnboardingDone(true); fetchSettings(); }} />
      )}
      <div
        className={`app-body${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
        style={{ gridTemplateColumns: gridCols }}
      >
        <Sidebar
          sessions={chats.sessions}
          activeId={chats.activeId}
          onNew={chats.newChat}
          onSwitch={chats.switchChat}
          onDelete={chats.deleteChat}
          onRename={chats.renameChat}
          onPin={chats.pinChat}
          activeView={view}
          onNavigate={handleNavigate}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          userName={userName}
          avatarUrl={avatarUrl}
        />

        {view === "projects" ? (
          <ProjectsView
            sessions={chats.sessions}
            models={visibleModels}
            model={model}
            onModelChange={handleModelChange}
            thinkingEnabled={thinkingEnabled}
            onThinkingToggle={() => setThinkingEnabled((v) => !v)}
            onClose={() => handleNavigate("chat")}
            onOpenChat={(id) => { chats.switchChat(id); handleNavigate("chat"); }}
            onStartChat={(pid, text, atts, html) => {
              chats.startProjectChat(pid, text, model, atts, html);
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
            mcpEnabled={chats.activeMcpEnabled}
            onToggleMcpServer={chats.toggleMcpServer}
          />
        )}
        {view === "chat" && panelOpen && !openFilePath && (
          <FilesPanel
            messages={chats.messages}
            onOpenFile={(path) => {
              setGeneralPanelOpen(false);
              setOpenFilePath(path);
            }}
            onClose={() => setGeneralPanelOpen(false)}
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
      {view === "settings" && (
        <div className="page-overlay">
          <SettingsPanel
            onClose={() => handleNavigate("chat")}
            initialTab={settingsTab}
            avatarUrl={avatarUrl}
            setAvatarFromFile={setAvatarFromFile}
            clearAvatar={clearAvatar}
            onSignOut={handleSignOut}
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
          <span>⚠ WSL not found — bash tool unavailable</span>
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
