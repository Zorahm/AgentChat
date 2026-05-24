/** Settings panel — v2: provider cards with models, paths. */

import { useCallback, useEffect, useState } from "react";
import { Key, Cpu, Folder, Command, Info, Sliders, Books, Plugs, ArrowLeft, ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";
import { useSettings } from "../../contexts/SettingsContext";
import { SkillsManager } from "../Skills/SkillsManager";
import { MainTab } from "./tabs/MainTab";
import { ProvidersTab } from "./tabs/ProvidersTab";
import { ModelsTab } from "./tabs/ModelsTab";
import { PathsTab } from "./tabs/PathsTab";
import { AboutTab } from "./tabs/AboutTab";
import { MCPTab } from "./tabs/MCPTab";

export interface ProviderConfig {
  id: string; name: string; api_key: string | null;
  api_base: string | null; enabled: boolean; api_key_set: boolean;
  custom?: boolean;
}
export interface ModelConfig {
  id: string; name?: string | null; thinking?: boolean | null;
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
  onboarding_completed?: boolean;
  unrestricted_mode?: boolean;
  shell_preference?: "auto" | "wsl" | "powershell";
  mcp_servers?: MCPServerConfig[];
}

export type NavTab = "providers" | "models" | "main" | "paths" | "shortcuts" | "about" | "skills" | "mcp";

interface SettingsPanelProps {
  onClose?: () => void;
  initialTab?: NavTab;
  avatarUrl: string | null;
  setAvatarFromFile: (file: File) => Promise<void>;
  clearAvatar: () => void;
  onSignOut: (deleteChats: boolean) => void;
  onStartGhostChat?: () => void;
}

export function SettingsPanel({ onClose, initialTab, avatarUrl, setAvatarFromFile, clearAvatar, onSignOut, onStartGhostChat }: SettingsPanelProps) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<Array<{ id: string; status: string; count: number; error: string | null }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [tab, setTab] = useState<NavTab>(initialTab ?? "providers");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setError(`Не удалось загрузить настройки: HTTP ${r.status}`);
      }
    } catch (e) {
      setError(`Не удалось подключиться к бэкенду (${API_BASE}): ${e instanceof Error ? e.message : "сеть"}`);
    }
    await fetchModels();
  }, [fetchModels]);

  useEffect(() => { reload(); }, [reload]);

  const updateProvider = async (id: string, p: Record<string, unknown>) => {
    setError(null);
    const r = await fetch(`${API_BASE}/settings/providers/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
    });
    if (!r.ok) { setError(`Ошибка сохранения: ${r.status}`); return; }
    await reload();
    return true;
  };

  const addProvider = async (body: { id: string; name: string; api_base: string; api_key?: string }) => {
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
    if (!confirm(`Удалить провайдера '${id}'?`)) return false;
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
      <nav className="st2-nav">
        {onClose && (
          <button className="st2-back" onClick={onClose}>← Назад</button>
        )}
        <div className="st2-group">Главное</div>
        <NavItem t="main" cur={tab} label="Главное" ic={<Sliders />} onClick={setTab} />
        <NavItem t="providers" cur={tab} label="Провайдеры" ic={<Key />} onClick={setTab} />
        <NavItem t="models" cur={tab} label="Модели" ic={<Cpu />} onClick={setTab} />
        <NavItem t="paths" cur={tab} label="Пути" ic={<Folder />} onClick={setTab} />
        <NavItem t="skills" cur={tab} label="Скиллы" ic={<Books />} onClick={setTab} />
        <NavItem t="mcp" cur={tab} label="MCP" ic={<Plugs />} onClick={setTab} />
        <div className="st2-group" style={{ marginTop: 8 }}>Прочее</div>
        <NavItem t="shortcuts" cur={tab} label="Горячие клавиши" ic={<Command />} onClick={setTab} />
        <NavItem t="about" cur={tab} label="О приложении" ic={<Info />} onClick={setTab} />
      </nav>

      <div className="st2-body">
        {error && <div className="st2-error">{error}</div>}
        {tab === "main" && <MainTab settings={settings} onUpdate={updateGlobal} avatarUrl={avatarUrl} setAvatarFromFile={setAvatarFromFile} clearAvatar={clearAvatar} onSignOut={onSignOut} />}
        {tab === "providers" && <ProvidersTab settings={settings} statuses={providerStatuses} loading={modelsLoading} expanded={expanded} setExpanded={setExpanded} onUpdate={updateProvider} onAdd={addProvider} onDelete={deleteProvider} onRefreshModels={() => fetchModels(true)} />}
        {tab === "models" && <ModelsTab settings={settings} loading={modelsLoading} onUpdate={updateGlobal} onRefresh={() => fetchModels(true)} />}
        {tab === "paths" && <PathsTab />}
        {tab === "skills" && <SkillsManager />}
        {tab === "mcp" && <MCPTab />}
        {tab === "shortcuts" && <Placeholder t="Горячие клавиши" />}
        {tab === "about" && <AboutTab onStartGhostChat={onStartGhostChat} />}
      </div>
    </div>
  );
}

/* ── Nav ─────────────────────────────────────── */

function NavItem({ t, cur, label, ic, onClick }: { t: NavTab; cur: NavTab; label: string; ic: React.ReactNode; onClick: (v: NavTab) => void }) {
  return <a className={`st2-nav-item${cur === t ? " active" : ""}`} onClick={() => onClick(t)}><span className="st2-nav-ic">{ic}</span>{label}</a>;
}

/* ── Placeholder ──────────────────── */

function Placeholder({ t }: { t: string }) {
  return <><h3 className="st2-h">{t}</h3><p className="st2-sub" style={{ color: "var(--muted)" }}>Скоро.</p></>;
}

/* ── Loading / Error ───────────────── */

function Loading({ error, onRetry, onClose }: { error: string | null; onRetry: () => void; onClose?: () => void }) {
  if (error) {
    return (
      <div className="error-page">
        <div className="error-card">
          <div className="error-icon-wrapper">
            <WarningCircle size={48} className="error-icon" weight="duotone" />
          </div>

          <h2 className="error-title">Что-то пошло не так</h2>

          <div className="error-message-box">
            <p className="error-message-text">{error}</p>
          </div>

          <p className="error-hint">
            Возникла ошибка при взаимодействии с сервером. Пожалуйста, проверьте, запущен ли бэкенд, или попробуйте снова.
          </p>

          <div className="error-actions">
            {onClose && (
              <button className="error-btn error-btn--secondary" onClick={onClose}>
                <ArrowLeft size={16} weight="bold" />
                <span>Назад к чатам</span>
              </button>
            )}
            <button className="error-btn error-btn--primary" onClick={onRetry}>
              <ArrowClockwise size={16} weight="bold" />
              <span>Повторить попытку</span>
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
        <p className="loading-text">Инициализация настроек…</p>
      </div>
    </div>
  );
}
