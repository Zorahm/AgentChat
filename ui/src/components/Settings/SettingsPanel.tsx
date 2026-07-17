/** Settings panel — v2: provider cards with models, paths. */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowClockwise, WarningCircle, User, Palette, TerminalWindow, ShieldWarning, Keyboard, Info, Cube, Cpu, Books, DeviceMobile, Plugs, Robot, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";
import { useSettings } from "../../contexts/SettingsContext";
import { SkillsManager } from "../Skills/SkillsManager";
import { ProfileTab } from "./tabs/ProfileTab";
import { AppearanceTab } from "./tabs/AppearanceTab";
import { TerminalTab } from "./tabs/TerminalTab";
import { SandboxTab } from "./tabs/SandboxTab";
import { ProvidersTab } from "./tabs/ProvidersTab";
import { ModelsTab } from "./tabs/ModelsTab";
import { PathsTab } from "./tabs/PathsTab";
import { AboutTab } from "./tabs/AboutTab";
import { MCPTab } from "./tabs/MCPTab";
import { AgentsTab } from "./tabs/AgentsTab";
import { ShortcutsTab } from "./tabs/ShortcutsTab";
import { useIsMobile } from "../../hooks/useIsMobile";

export interface ProviderConfig {
  id: string; name: string; api_key: string | null;
  api_base: string | null; enabled: boolean; api_key_set: boolean;
  custom?: boolean;
  extra_headers?: Record<string, string> | null;
}
export interface ModelConfig {
  id: string; name?: string | null; thinking?: boolean | null;
  thinking_types?: string[] | null; effort_levels?: string[] | null;
}
export interface MCPStdioConfig {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  runtime: "host" | "wsl";
}
export interface MCPHttpConfig {
  transport: "http";
  url: string;
  headers: Record<string, string>;
}
export type MCPTransportConfig = MCPStdioConfig | MCPHttpConfig;
export interface MCPServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  config: MCPTransportConfig;
}
export interface SettingsData {
  providers: ProviderConfig[]; models: ModelConfig[];
  default_model: string; temperature: number; max_iterations: number;
  user_name: string;
  theme: string;
  notify_sound?: boolean;
  notify_sound_data?: string | null;
  notify_sound_name?: string | null;
  language?: string;
  onboarding_completed?: boolean;
  unrestricted_mode?: boolean;
  shell_preference?: "auto" | "wsl" | "powershell" | "zsh";
  web_search_mode?: string;
  searxng_url?: string | null;
  tavily_api_key_set?: boolean;
  research_enabled?: boolean;
  research_model?: string;
  mcp_servers?: MCPServerConfig[];
  describe_actions?: boolean;
}

export type NavTab =
  | "profile" | "appearance" | "shortcuts" | "about"
  | "providers" | "models" | "skills"
  | "terminal" | "sandbox" | "paths" | "mcp" | "agents";

interface SettingsPanelProps {
  onClose?: () => void;
  initialTab?: NavTab;
  avatarUrl: string | null;
  setAvatarFromFile: (file: File) => Promise<void>;
  clearAvatar: () => void;
  onSignOut: (deleteChats: boolean) => void;
  onOpenOnboarding: () => void;
  onStartGhostChat?: () => void;
}

export function SettingsPanel({ onClose, initialTab, avatarUrl, setAvatarFromFile, clearAvatar, onSignOut, onOpenOnboarding, onStartGhostChat }: SettingsPanelProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<Array<{ id: string; status: string; count: number; error: string | null }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [tab, setTab] = useState<NavTab>(initialTab ?? "providers");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileShowList, setMobileShowList] = useState(!initialTab);

  const fetchModels = useCallback(async (refresh = false) => {
    setModelsLoading(true);
    try {
      const url = `${API_BASE}/models${refresh ? "?refresh=true" : ""}`;
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        setSettings((prev) => prev ? { ...prev, models: data.models ?? [] } : prev);
        setProviderStatuses(data.providers ?? []);
      }
    } catch { /* no-op */ } finally { setModelsLoading(false); }
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/settings`);
      if (r.ok) {
        const data = await r.json();
        setSettings({ ...data, models: data.models ?? [] });
        setError(null);
      } else {
        setError(t("settings.loadError", { status: r.status }));
      }
    } catch (e) {
      setError(t("settings.connectionError", { apiBase: API_BASE, message: e instanceof Error ? e.message : "unknown" }));
    }
    await fetchModels();
  }, [fetchModels]);

  useEffect(() => { reload(); }, [reload]);

  const handleTabClick = (v: NavTab) => { setTab(v); setMobileShowList(false); };

  const updateProvider = async (id: string, p: Record<string, unknown>) => {
    setError(null);
    const r = await fetch(`${API_BASE}/settings/providers/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
    });
    if (!r.ok) { setError(t("settings.saveError", { status: r.status })); return; }
    await reload();
    return true;
  };

  const addProvider = async (body: { id: string; name: string; api_base: string; api_key?: string; extra_headers?: Record<string, string> }) => {
    setError(null);
    const r = await fetch(`${API_BASE}/settings/providers`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      try { const j = await r.json(); setError(j.detail ?? `HTTP ${r.status}`); }
      catch { setError(`HTTP ${r.status}`); }
      return false;
    }
    await reload();
    return true;
  };

  const deleteProvider = async (id: string) => {
    setError(null);
    if (!confirm(t("settings.deleteConfirm", { id }))) return false;
    const r = await fetch(`${API_BASE}/settings/providers/${id}`, { method: "DELETE" });
    if (!r.ok) {
      try { const j = await r.json(); setError(j.detail ?? `HTTP ${r.status}`); }
      catch { setError(`HTTP ${r.status}`); }
      return false;
    }
    await reload();
    return true;
  };

  const { updateSettings: ctxUpdateSettings } = useSettings();

  const updateGlobal = async (p: Record<string, unknown>) => {
    setError(null);
    await ctxUpdateSettings(p);
    await reload();
  };

  if (!settings) return <Loading error={error} onRetry={reload} onClose={onClose} />;

  const tabDefs: Array<{ id: NavTab; icon: React.ReactNode }> = [
    { id: "profile", icon: <User size={20} /> },
    { id: "appearance", icon: <Palette size={20} /> },
    { id: "shortcuts", icon: <Keyboard size={20} /> },
    { id: "about", icon: <Info size={20} /> },
    { id: "providers", icon: <Cube size={20} /> },
    { id: "models", icon: <Cpu size={20} /> },
    { id: "skills", icon: <Books size={20} /> },
    { id: "terminal", icon: <TerminalWindow size={20} /> },
    { id: "sandbox", icon: <ShieldWarning size={20} /> },
    { id: "paths", icon: <DeviceMobile size={20} /> },
    { id: "mcp", icon: <Plugs size={20} /> },
    { id: "agents", icon: <Robot size={20} /> },
  ];

  const mobileGroups: Array<{ group: string; items: Array<{ id: NavTab; icon: React.ReactNode }> }> = [
    {
      group: t("settings.nav.personal"),
      items: [
        { id: "profile", icon: <User size={18} /> },
        { id: "appearance", icon: <Palette size={18} /> },
        { id: "shortcuts", icon: <Keyboard size={18} /> },
        { id: "about", icon: <Info size={18} /> },
      ],
    },
    {
      group: t("settings.nav.modelGroup"),
      items: [
        { id: "providers", icon: <Cube size={18} /> },
        { id: "models", icon: <Cpu size={18} /> },
        { id: "skills", icon: <Books size={18} /> },
      ],
    },
    {
      group: t("settings.nav.systemGroup"),
      items: [
        { id: "terminal", icon: <TerminalWindow size={18} /> },
        { id: "sandbox", icon: <ShieldWarning size={18} /> },
        { id: "paths", icon: <DeviceMobile size={18} /> },
        { id: "mcp", icon: <Plugs size={18} /> },
        { id: "agents", icon: <Robot size={18} /> },
      ],
    },
  ];

  return (
    <div className="st2">
      <nav className="st2-nav">
        <h2 className="st2-nav-h"><img className="st2-nav-mark" src="/dots.svg" alt="" /> {t("settings.nav.title")}</h2>

        {onClose && (
          <button className="st2-back" onClick={onClose}>{t("settings.back")}</button>
        )}
        <div className="st2-group">{t("settings.nav.personal")}</div>
        <NavItem t="profile" cur={tab} label={t("settings.nav.profile")} ic={<User size={16} />} onClick={handleTabClick} />
        <NavItem t="appearance" cur={tab} label={t("settings.nav.appearance")} ic={<Palette size={16} />} onClick={handleTabClick} />
        <NavItem t="shortcuts" cur={tab} label={t("settings.nav.shortcuts")} ic={<Keyboard size={16} />} onClick={handleTabClick} />
        <NavItem t="about" cur={tab} label={t("settings.nav.about")} ic={<Info size={16} />} onClick={handleTabClick} />

        <div className="st2-group">{t("settings.nav.modelGroup")}</div>
        <NavItem t="providers" cur={tab} label={t("settings.nav.providers")} ic={<Cube size={16} />} onClick={handleTabClick} />
        <NavItem t="models" cur={tab} label={t("settings.nav.models")} ic={<Cpu size={16} />} onClick={handleTabClick} />
        <NavItem t="skills" cur={tab} label={t("settings.nav.skills")} ic={<Books size={16} />} onClick={handleTabClick} />

        <div className="st2-group">{t("settings.nav.systemGroup")}</div>
        <NavItem t="terminal" cur={tab} label={t("settings.nav.terminal")} ic={<TerminalWindow size={16} />} onClick={handleTabClick} />
        <NavItem t="sandbox" cur={tab} label={t("settings.nav.sandbox")} ic={<ShieldWarning size={16} />} onClick={handleTabClick} />
        <NavItem t="paths" cur={tab} label={t("settings.nav.paths")} ic={<DeviceMobile size={16} />} onClick={handleTabClick} />
        <NavItem t="mcp" cur={tab} label={t("settings.nav.mcp")} ic={<Plugs size={16} />} onClick={handleTabClick} />
        <NavItem t="agents" cur={tab} label={t("settings.nav.agents")} ic={<Robot size={16} />} onClick={handleTabClick} />

        <div className="st2-nav-pad" />
        <div className="st2-nav-foot">
          <span className="st2-nav-dot" />
        </div>
      </nav>

      {isMobile && mobileShowList ? (
        <div className="st2-body st2-mlist-body">
          <div className="st2-mob-bar">
            {onClose && (
              <button className="st2-mob-btn" onClick={onClose} aria-label={t("settings.back")} title={t("settings.back")}>
                <CaretLeft size={22} />
              </button>
            )}
            <span className="st2-mob-title">{t("settings.nav.title")}</span>
          </div>
          {error && <div className="st2-error">{error}</div>}
          {mobileGroups.map((g) => (
            <div key={g.group} className="st2-mlist-group">
              <div className="st2-group">{g.group}</div>
              <div className="st2-mlist">
                {g.items.map((d) => (
                  <a
                    key={d.id}
                    className="st2-mlist-item"
                    onClick={() => handleTabClick(d.id)}
                  >
                    <span className="st2-nav-ic">{d.icon}</span>
                    <span className="st2-mlist-label">{t(`settings.nav.${d.id}`)}</span>
                    <CaretRight size={16} className="st2-mlist-chev" />
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="st2-body">
          {isMobile && (
            <div className="st2-mob-bar">
              <button className="st2-mob-btn" onClick={() => setMobileShowList(true)} aria-label={t("settings.back")} title={t("settings.back")}>
                <CaretLeft size={22} />
              </button>
              <span className="st2-mob-title">{t(`settings.nav.${tab}`)}</span>
            </div>
          )}
          {error && <div className="st2-error">{error}</div>}
          {tab === "profile" && <ProfileTab settings={settings} onUpdate={updateGlobal} avatarUrl={avatarUrl} setAvatarFromFile={setAvatarFromFile} clearAvatar={clearAvatar} onSignOut={onSignOut} onOpenOnboarding={onOpenOnboarding} />}
          {tab === "appearance" && <AppearanceTab settings={settings} onUpdate={updateGlobal} />}
          {tab === "terminal" && <TerminalTab settings={settings} onUpdate={updateGlobal} />}
          {tab === "sandbox" && <SandboxTab settings={settings} onUpdate={updateGlobal} />}
          {tab === "providers" && <ProvidersTab settings={settings} statuses={providerStatuses} loading={modelsLoading} expanded={expanded} setExpanded={setExpanded} onUpdate={updateProvider} onAdd={addProvider} onDelete={deleteProvider} onRefreshModels={() => fetchModels(true)} onUpdateGlobal={updateGlobal} />}
          {tab === "models" && <ModelsTab settings={settings} loading={modelsLoading} onUpdate={updateGlobal} onRefresh={() => fetchModels(true)} />}
          {tab === "paths" && <PathsTab />}
          {tab === "skills" && <SkillsManager />}
          {tab === "mcp" && <MCPTab />}
          {tab === "agents" && <AgentsTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
          {tab === "about" && <AboutTab onStartGhostChat={onStartGhostChat} />}
        </div>
      )}
    </div>
  );
}

/* ── Nav ─────────────────────────────────────── */

function NavItem({ t, cur, label, ic, onClick }: { t: NavTab; cur: NavTab; label: string; ic: React.ReactNode; onClick: (v: NavTab) => void }) {
  return <a className={`st2-nav-item${cur === t ? " active" : ""}`} onClick={() => onClick(t)}><span className="st2-nav-ic">{ic}</span>{label}</a>;
}

/* ── Loading / Error ───────────────── */

function Loading({ error, onRetry, onClose }: { error: string | null; onRetry: () => void; onClose?: () => void }) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="error-page">
        <div className="error-card">
          <div className="error-icon-wrapper">
            <WarningCircle size={48} className="error-icon" weight="duotone" />
          </div>

          <h2 className="error-title">{t("settings.errorTitle")}</h2>

          <div className="error-message-box">
            <p className="error-message-text">{error}</p>
          </div>

          <p className="error-hint">
            {t("settings.errorHint")}
          </p>

          <div className="error-actions">
            {onClose && (
              <button className="error-btn error-btn--secondary" onClick={onClose}>
                <ArrowLeft size={16} weight="bold" />
                <span>{t("settings.backToChats")}</span>
              </button>
            )}
            <button className="error-btn error-btn--primary" onClick={onRetry}>
              <ArrowClockwise size={16} weight="bold" />
                <span>{t("settings.retry")}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="loading-page">
      <div className="loading-container">
        <div className="loading-spinner" />
        <p className="loading-text">{t("settings.initLoading")}</p>
      </div>
    </div>
  );
}
