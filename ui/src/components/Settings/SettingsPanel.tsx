/** Settings panel — v2: provider cards with models, paths. */

import { useCallback, useEffect, useState } from "react";
import { Key, Cpu, Folder, Command, Info, Sliders, Sun, Moon, Monitor } from "@phosphor-icons/react";
import { Atom, Lightning, Desktop, Brain, Code, User, GithubLogo, Globe } from "@phosphor-icons/react";
import { API_BASE, setBackendUrl } from "../../utils/apiBase";
import pkg from "../../../package.json";

export interface ProviderConfig {
  id: string; name: string; api_key: string | null;
  api_base: string | null; enabled: boolean; api_key_set: boolean;
  custom?: boolean;
}
export interface ModelConfig {
  id: string; name?: string | null; thinking?: boolean | null;
}
interface SettingsData {
  providers: ProviderConfig[]; models: ModelConfig[];
  default_model: string; temperature: number; max_iterations: number;
  user_name: string;
  theme: string;
  onboarding_completed?: boolean;
}

type NavTab = "providers" | "models" | "main" | "paths" | "shortcuts" | "about";

const MAX_ITER_MIN = 1;
const MAX_ITER_MAX = 200;

/* ═══════════════════════════════════════════════ */

interface ProviderStatus { id: string; status: string; count: number; error: string | null }

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [tab, setTab] = useState<NavTab>("providers");
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

  const updateGlobal = async (p: Record<string, unknown>) => {
    setError(null);
    const r = await fetch(`${API_BASE}/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
    });
    if (!r.ok) { setError(`Ошибка сохранения: ${r.status}`); return; }
    await reload();
    window.dispatchEvent(new CustomEvent("settings-changed"));
  };

  if (!settings) return <Loading error={error} onRetry={reload} />;

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
        <div className="st2-group" style={{ marginTop: 8 }}>Прочее</div>
        <NavItem t="shortcuts" cur={tab} label="Горячие клавиши" ic={<Command />} onClick={setTab} />
        <NavItem t="about" cur={tab} label="О приложении" ic={<Info />} onClick={setTab} />
      </nav>

      <div className="st2-body">
        {error && <div className="st2-error">{error}</div>}
        {tab === "main" && <MainTab settings={settings} onUpdate={updateGlobal} />}
        {tab === "providers" && <ProvidersTab settings={settings} statuses={providerStatuses} loading={modelsLoading} expanded={expanded} setExpanded={setExpanded} onUpdate={updateProvider} onAdd={addProvider} onDelete={deleteProvider} onRefreshModels={() => fetchModels(true)} />}
        {tab === "models" && <ModelsTab settings={settings} loading={modelsLoading} onUpdate={updateGlobal} onRefresh={() => fetchModels(true)} />}
        {tab === "paths" && <PathsTab />}
        {tab === "shortcuts" && <Placeholder t="Горячие клавиши" />}
        {tab === "about" && <AboutTab />}
      </div>
    </div>
  );
}

/* ── Nav ─────────────────────────────────────── */

function NavItem({ t, cur, label, ic, onClick }: { t: NavTab; cur: NavTab; label: string; ic: React.ReactNode; onClick: (v: NavTab) => void }) {
  return <a className={`st2-nav-item${cur === t ? " active" : ""}`} onClick={() => onClick(t)}><span className="st2-nav-ic">{ic}</span>{label}</a>;
}

/* ── Providers ───────────────────────────────── */

function ProvidersTab({ settings, statuses, loading, expanded, setExpanded, onUpdate, onAdd, onDelete, onRefreshModels }: {
  settings: SettingsData;
  statuses: ProviderStatus[];
  loading: boolean;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  onUpdate: (id: string, p: Record<string, unknown>) => Promise<boolean | undefined>;
  onAdd: (body: { id: string; name: string; api_base: string; api_key?: string }) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRefreshModels: () => void;
}) {
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">Провайдеры</h3>
        <p className="st2-sub">Модели подгружаются с {`{api_base}/models`} каждого провайдера.</p>
      </div>
      <button className="st2-btn" onClick={onRefreshModels} disabled={loading}>
        {loading ? "Обновляю…" : "Обновить модели"}
      </button>
    </div>
    {settings.providers.map((p) => (
      <ProviderCard key={p.id} p={p}
        models={settings.models.filter((m) => m.id.startsWith(p.id + "/"))}
        status={statusMap.get(p.id)}
        defaultModel={settings.default_model} open={expanded === p.id}
        onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
        onUpdate={(x) => onUpdate(p.id, x)}
        onDelete={p.custom ? () => onDelete(p.id) : undefined} />
    ))}
    <AddProviderForm existingIds={new Set(settings.providers.map((p) => p.id))} onAdd={onAdd} />
  </>;
}

function AddProviderForm({ existingIds, onAdd }: {
  existingIds: Set<string>;
  onAdd: (body: { id: string; name: string; api_base: string; api_key?: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => { setId(""); setName(""); setBase(""); setKey(""); setErr(null); };

  const submit = async () => {
    setErr(null);
    const trimmedId = id.trim().toLowerCase();
    if (!trimmedId || !name.trim() || !base.trim()) {
      setErr("ID, название и api_base обязательны");
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(trimmedId)) {
      setErr("ID: только латиница, цифры, _ и -");
      return;
    }
    if (existingIds.has(trimmedId)) {
      setErr(`Провайдер '${trimmedId}' уже существует`);
      return;
    }
    setSaving(true);
    const ok = await onAdd({ id: trimmedId, name: name.trim(), api_base: base.trim(), api_key: key.trim() || undefined });
    setSaving(false);
    if (ok) { reset(); setOpen(false); }
    else setErr("Не удалось сохранить");
  };

  if (!open) {
    return (
      <button className="st2-add-btn" onClick={() => setOpen(true)}>
        + Добавить OpenAI-совместимого провайдера
      </button>
    );
  }

  return (
    <div className="st2-add-form">
      <h4>Свой провайдер (OpenAI-совместимый)</h4>
      <p className="st2-sub2">Должен поддерживать <code>{`{api_base}/models`}</code> и <code>{`{api_base}/chat/completions`}</code>.</p>
      <div className="st2-add-grid">
        <label>ID
          <input className="st2-field" placeholder="my-provider" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label>Название
          <input className="st2-field" placeholder="My Provider" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>API Base
          <input className="st2-field" placeholder="https://api.example.com/v1" value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>API Key
          <input type="password" className="st2-field" placeholder="(опционально)" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
      </div>
      {err && <div className="st2-add-err">{err}</div>}
      <div className="st2-add-actions">
        <button className="st2-btn" onClick={submit} disabled={saving}>{saving ? "Сохраняю…" : "Добавить"}</button>
        <button className="st2-btn st2-btn--ghost" onClick={() => { reset(); setOpen(false); }}>Отмена</button>
      </div>
    </div>
  );
}

/* ── Provider card ───────────────────────────── */

const LOGO: Record<string, string> = {
  openai: "lg-openai", anthropic: "lg-anthropic", gemini: "lg-google",
  deepseek: "lg-deepseek", groq: "lg-groq", mistral: "lg-mistral",
  cohere: "lg-cohere", together: "lg-together", openrouter: "lg-openrouter",
  ollama: "lg-ollama", lmstudio: "lg-lmstudio", litellm_proxy: "lg-proxy",
  opencode: "lg-opencode",
};

function ProviderCard({ p, models, status, defaultModel, open, onToggle, onUpdate, onDelete }: {
  p: ProviderConfig; models: ModelConfig[]; status?: ProviderStatus;
  defaultModel: string;
  open: boolean; onToggle: () => void;
  onUpdate: (patch: Record<string, unknown>) => Promise<boolean | undefined>;
  onDelete?: () => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  const logo = p.name[0]?.toUpperCase() ?? "?";

  const handleSaveKey = async () => {
    if (!key.trim()) return;
    const ok = await onUpdate({ api_key: key.trim() });
    if (ok) setKey("");
  };

  const badge = status?.status === "error"
    ? <span className="st2-pv-badge err" title={status.error ?? ""}>ошибка</span>
    : status?.status === "ok"
    ? <span className="st2-pv-badge ok">{status.count} моделей</span>
    : null;

  return (
    <div className="st2-provider">
      <div className="st2-pv-head" onClick={onToggle}>
        <div className={`st2-pv-logo ${LOGO[p.id] ?? "lg-other"}`}>{logo}</div>
        <div className="st2-pv-name">{p.name}<small>{p.api_base ?? "—"}</small></div>
        {badge}
        <div className="st2-pv-key">{p.api_key_set ? "••••" : "без ключа"}</div>
        <div className={`st2-switch${p.enabled ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !p.enabled }); }} />
      </div>
      {open && (
        <div className="st2-pv-body">
          {status?.status === "error" && (
            <div className="st2-pv-err">Не удалось получить список моделей: {status.error}</div>
          )}
          {models.length === 0 && status?.status !== "error" && (
            <div className="st2-pv-empty">Моделей нет.{p.api_key_set ? "" : " Добавь ключ и обнови список."}</div>
          )}
          {models.map((m) => (
            <div key={m.id} className="st2-pv-row">
              <span className="st2-pv-model">{m.name ?? m.id}</span>
              {m.thinking && <span className="st2-think-tag">thinking</span>}
              <div className={`st2-switch${m.id === defaultModel ? " on" : ""}`} />
            </div>
          ))}
          <div className="st2-pv-key-row">
            <input type="password" className="st2-field"
              placeholder={p.api_key_set ? "•••• (установить новый)" : "API ключ…"}
              value={key} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveKey()} />
            <button className="st2-btn" onClick={handleSaveKey}>
              Сохранить
            </button>
            {onDelete && (
              <button className="st2-btn st2-btn--danger" onClick={onDelete}>
                Удалить
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Models ──────────────────────────────────── */

function ModelsTab({ settings, loading, onUpdate, onRefresh }: {
  settings: SettingsData; loading: boolean;
  onUpdate: (p: Record<string, unknown>) => void;
  onRefresh: () => void;
}) {
  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">Модели</h3>
        <p className="st2-sub">Список загружается из /models у каждого провайдера.</p>
      </div>
      <button className="st2-btn" onClick={onRefresh} disabled={loading}>
        {loading ? "Обновляю…" : "Обновить"}
      </button>
    </div>
    <div className="st2-section">
      <h4>Модель по умолчанию</h4>
      <select className="st2-select" value={settings.default_model}
        onChange={(e) => onUpdate({ default_model: e.target.value })}>
        {settings.models.length === 0 && <option value="">— нет моделей —</option>}
        {settings.models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
      </select>
    </div>
    <div className="st2-section">
      <h4>Температура · {settings.temperature}</h4>
      <input type="range" min={0} max={2} step={0.1} value={settings.temperature}
        onChange={(e) => onUpdate({ temperature: Number(e.target.value) })}
        style={{ width: "100%", maxWidth: 300 }} />
    </div>
    <div className="st2-section">
      <h4>Макс. итераций агента (tool use)</h4>
      <input type="number" min={MAX_ITER_MIN} max={MAX_ITER_MAX} className="st2-num" value={settings.max_iterations}
        onChange={(e) => onUpdate({ max_iterations: Number(e.target.value) })} />
      <p className="st2-sub2">от {MAX_ITER_MIN} до {MAX_ITER_MAX}</p>
    </div>
  </>;
}

/* ── Main Settings ──────────────────── */

function MainTab({ settings, onUpdate }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
}) {
  const [draft, setDraft] = useState(settings.user_name ?? "");

  useEffect(() => {
    setDraft(settings.user_name ?? "");
  }, [settings.user_name]);

  const handleBlur = useCallback(() => {
    if (draft !== (settings.user_name ?? "")) {
      onUpdate({ user_name: draft });
    }
  }, [draft, settings.user_name, onUpdate]);

  const currentTheme = settings.theme || "system";

  return <>
    <h3 className="st2-h">Главное</h3>
    <div className="st2-section">
      <h4>Имя пользователя</h4>
      <p className="st2-sub2">Как модель будет к вам обращаться.</p>
      <input type="text" className="st2-input" value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        placeholder="Введите имя" />
    </div>
    <div className="st2-section">
      <h4>Тема оформления</h4>
      <p className="st2-sub2">Выберите светлую, тёмную или системную тему.</p>
      <div className="st2-theme">
        <button className={currentTheme === "light" ? "active" : ""}
          onClick={() => onUpdate({ theme: "light" })}>
          <Sun /> Светлая
        </button>
        <button className={currentTheme === "dark" ? "active" : ""}
          onClick={() => onUpdate({ theme: "dark" })}>
          <Moon /> Тёмная
        </button>
        <button className={currentTheme === "system" ? "active" : ""}
          onClick={() => onUpdate({ theme: "system" })}>
          <Monitor /> Системная
        </button>
      </div>
    </div>
  </>;
}

/* ── Paths / About ──────────────────── */

function PathsTab() {
  const [backendUrl, setBackendUrlState] = useState(
    localStorage.getItem("agentchat.backendUrl") ?? ""
  );

  return <>
    <h3 className="st2-h">Пути</h3>
    <div className="st2-section">
      <h4>Папка скиллов</h4>
      <p className="st2-sub2">Распакованные .skill-пакеты. Watchdog следит за изменениями.</p>
      <div className="st2-path"><Folder /> skills/</div>
    </div>
    <div className="st2-section">
      <h4>Рабочая директория</h4>
      <p className="st2-sub2">Корень для bash_tool, относительные пути.</p>
      <div className="st2-path"><Folder /> ~/work</div>
    </div>
    <div className="st2-section">
      <h4>URL бэкенда</h4>
      <p className="st2-sub2">Оставьте пустым для локального (по умолчанию). Укажите адрес сервера для удалённого доступа с телефона.</p>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          value={backendUrl}
          onChange={(e) => setBackendUrlState(e.target.value)}
          placeholder="http://192.168.1.x:8787"
          style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text)", fontSize: 13 }}
        />
        <button
          onClick={() => setBackendUrl(backendUrl)}
          style={{ padding: "6px 14px", borderRadius: 6, background: "var(--color-accent, #5865f2)", color: "#fff", border: "none", cursor: "pointer", fontSize: 13 }}
        >
          Применить
        </button>
      </div>
    </div>
  </>;
}

function Placeholder({ t }: { t: string }) {
  return <><h3 className="st2-h">{t}</h3><p className="st2-sub" style={{ color: "var(--muted)" }}>Скоро.</p></>;
}

function AboutTab() {
  const stack = [
    { name: "React", icon: <Atom />, desc: "UI-фреймворк" },
    { name: "TypeScript", icon: <Code />, desc: "Типизированный фронтенд" },
    { name: "FastAPI", icon: <Lightning />, desc: "Асинхронный бэкенд" },
    { name: "LiteLLM", icon: <Brain />, desc: "Прокси для LLM-провайдеров" },
    { name: "Tauri", icon: <Desktop />, desc: "Десктопная оболочка" },
    { name: "Python", icon: <Code />, desc: "Агентный цикл, инструменты" },
  ];

  return <>
    <h3 className="st2-h">О приложении</h3>
    <p className="st2-sub">
      AgentChat — десктопный агентский чат для разработки.<br />
      Локальный, конфиденциальный, с файловой системой под рукой.
    </p>

    <div className="st2-section">
      <h4 style={{ marginBottom: 10 }}>Стек</h4>
      <div className="st2-about-stack">
        {stack.map((s) => (
          <div key={s.name} className="st2-about-stack-item">
            <span className="st2-about-stack-ic">{s.icon}</span>
            <span className="st2-about-stack-name">{s.name}</span>
            <span className="st2-about-stack-desc">{s.desc}</span>
          </div>
        ))}
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 10 }}>Версия приложения</h4>
      <div className="st2-about-author" style={{ gap: 12 }}>
        <img src="/dots.svg" alt="" style={{ width: 36, height: 36, borderRadius: 7 }} />
        <div>
          <span className="st2-about-author-name">AgentChat</span>
          <span className="st2-about-author-meta">v{pkg.version}</span>
        </div>
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 6 }}>Автор</h4>
      <div className="st2-about-author">
        <span className="st2-about-author-ic"><img src="https://github.com/zorahm.png" alt="" /></span>
        <div>
          <span className="st2-about-author-name">zorahm</span>
        </div>
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 10 }}>Ссылки</h4>
      <div className="st2-about-links">
        <a className="st2-about-link" href="https://github.com/zorahm" target="_blank" rel="noopener noreferrer">
          <GithubLogo /> github.com/zorahm
        </a>
        <a className="st2-about-link" href="https://zorahm.ru" target="_blank" rel="noopener noreferrer">
          <Globe /> zorahm.ru
        </a>
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 6 }}>Цель</h4>
      <p className="st2-sub2">
        Собрать агента, который живёт на твоей машине: читает файлы, пишет код,
        вызывает инструменты, помнит контекст. Без облаков, без задержек, без
        лишних абстракций.
      </p>
    </div>
  </>;
}

function Loading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="st2">
      <div className="st2-body">
        {error ? (
          <>
            <div className="st2-error">{error}</div>
            <button className="st2-btn" onClick={onRetry} style={{ marginTop: 12 }}>Повторить</button>
          </>
        ) : (
          <p style={{ color: "var(--muted)" }}>Загрузка…</p>
        )}
      </div>
    </div>
  );
}
