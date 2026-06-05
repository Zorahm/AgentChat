/** Settings panel — v2: provider cards with models, paths. */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowClockwise, WarningCircle, User, Palette, TerminalWindow, ShieldWarning, Keyboard, Info, Cube, Cpu, Books, DeviceMobile, Plugs, List } from "@phosphor-icons/react";
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
import { ShortcutsTab } from "./tabs/ShortcutsTab";

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
  language?: string;
  onboarding_completed?: boolean;
  unrestricted_mode?: boolean;
  shell_preference?: "auto" | "wsl" | "powershell";
  web_search_mode?: string;
  searxng_url?: string | null;
  tavily_api_key_set?: boolean;
  mcp_servers?: MCPServerConfig[];
}

export type NavTab =
  | "profile" | "appearance" | "shortcuts" | "about"
  | "providers" | "models" | "skills"
  | "terminal" | "sandbox" | "paths" | "mcp";

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
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<Array<{ id: string; status: string; count: number; error: string | null }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [tab, setTab] = useState<NavTab>(initialTab ?? "providers");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNavOpen(false); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [mobileNavOpen]);

  const handleTabClick = (v: NavTab) => { setTab(v); setMobileNavOpen(false); };

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

  return (
    <div className="st2">
      {mobileNavOpen && <div className="st2-nav-backdrop" onClick={() => setMobileNavOpen(false)} />}
      <nav className={`st2-nav${mobileNavOpen ? " mobile-open" : ""}`}>
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

        <div className="st2-nav-pad" />
        <div className="st2-nav-foot">
          <span className="st2-nav-dot" />
        </div>
      </nav>

      <div className="st2-body">
        <div className="st2-mob-bar">
          <button className="st2-mob-btn" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
            <List size={22} />
          </button>
          <span className="st2-mob-title">{t(`settings.nav.${tab}`)}</span>
        </div>
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
        {tab === "shortcuts" && <ShortcutsTab />}
        {tab === "about" && <AboutTab onStartGhostChat={onStartGhostChat} />}
      </div>
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
