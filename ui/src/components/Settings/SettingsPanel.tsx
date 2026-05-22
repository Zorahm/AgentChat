/** Settings panel — v2: provider cards with models, paths. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Key, Cpu, Folder, Command, Info, Sliders, Sun, Moon, Monitor, Books, Plus, MagnifyingGlass, CaretDown, Trash, DotsThree, LinkSimple } from "@phosphor-icons/react";
import { Atom, Lightning, Desktop, Brain, Code, User, GithubLogo, Globe, ArrowClockwise, CheckCircle, WarningCircle, Terminal, XCircle } from "@phosphor-icons/react";
import { Markdown } from "../Markdown/Markdown";
import { API_BASE, setBackendUrl } from "../../utils/apiBase";
import { checkForUpdates, isTauri, UpdateStatus } from "../../utils/updater";
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
  unrestricted_mode?: boolean;
  shell_preference?: "auto" | "wsl" | "powershell";
}

interface ShellStatus {
  wsl_installed: boolean;
  default_distro: string | null;
  distro_running: boolean;
  node: string | null;
  python: string | null;
  npm: string | null;
  pandoc: string | null;
  docx: boolean;
  dns_ok: boolean;
  powershell_available: boolean;
  active_shell: "wsl" | "powershell";
  shell_preference: "auto" | "wsl" | "powershell";
}

export type NavTab = "providers" | "models" | "main" | "paths" | "shortcuts" | "about" | "skills";

const MAX_ITER_MIN = 1;
const MAX_ITER_MAX = 200;

/* ═══════════════════════════════════════════════ */

interface ProviderStatus { id: string; status: string; count: number; error: string | null }

interface SettingsPanelProps {
  onClose?: () => void;
  initialTab?: NavTab;
}

export function SettingsPanel({ onClose, initialTab }: SettingsPanelProps) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
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
        <NavItem t="skills" cur={tab} label="Скиллы" ic={<Books />} onClick={setTab} />
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
        {tab === "skills" && <SkillsTab />}
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
  const unrestricted = settings.unrestricted_mode ?? false;

  return (
    <div className="st2-main">
      <h3 className="st2-h">Главное</h3>
      <p className="st2-sub">
        Личные настройки и поведение приложения по умолчанию.
        Всё хранится локально — никаких облачных аккаунтов.
      </p>

      {/* 01 Профиль */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>Профиль</h2>
        </div>
        <p className="st2-md">
          Как модель к вам обращается. Не отправляется наружу.
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">Имя пользователя</p>
              <p className="d">
                Модель использует это имя в обращениях. Можно оставить пустым — тогда без обращений.
              </p>
            </div>
            <div className="st2-mctl">
              <input type="text" className="st2-input" value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={handleBlur}
                placeholder="Введите имя" />
            </div>
          </div>
        </div>
      </section>

      {/* 02 Оформление */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>Оформление</h2>
        </div>
        <p className="st2-md">
          Светлая, тёмная или системная тема. Полная палитра настраивается в теме CSS.
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">Тема оформления</p>
              <p className="d">Цветовая схема всего интерфейса.</p>
            </div>
            <div className="st2-mctl">
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
          </div>
        </div>
      </section>

      {/* 03 Песочница */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">03</span>
          <h2>Песочница</h2>
        </div>
        <p className="st2-md">
          Граница доступа к файлам и оболочке. По умолчанию модель видит только папку текущего чата.
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow stack">
            <div className="st2-mctl">
              <div className={`st2-danger-row${unrestricted ? " on" : ""}`}>
                <div className="lab">
                  <p className="t">Unrestricted mode</p>
                  <p className="d">
                    Полный доступ к ПК — модель сможет читать <code>~/.ssh</code>,
                    <code>AppData</code> и писать куда угодно. Включайте, только если
                    понимаете риск.
                  </p>
                </div>
                <div className="st2-danger-switch">
                  <div className={`st2-switch${unrestricted ? " on" : ""}`}
                    onClick={() => onUpdate({ unrestricted_mode: !unrestricted })} />
                </div>
              </div>
              {unrestricted && (
                <div className="st2-risk-note">
                  <b>Песочница снята.</b> Модель и агент имеют полный доступ к WSL и Windows.
                  <ul>
                    <li>Модель может читать любые файлы, включая <code>~/.ssh</code> и <code>AppData</code>.</li>
                    <li>bash и другие инструменты работают без изоляции.</li>
                    <li>Перезапустите агента, чтобы вернуть песочницу.</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 04 Терминал */}
      <ShellSection
        preference={settings.shell_preference ?? "auto"}
        onChange={(v) => onUpdate({ shell_preference: v })}
      />
    </div>
  );
}

/* ── Shell (WSL ⇄ PowerShell) ───────────────────── */

function ShellSection({
  preference,
  onChange,
}: {
  preference: "auto" | "wsl" | "powershell";
  onChange: (v: "auto" | "wsl" | "powershell") => void;
}) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<null | "distro" | "deps" | "dns">(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/wsl/status`);
      if (r.ok) setStatus(await r.json());
    } catch { /* no-op */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const installDistro = async () => {
    setInstalling("distro");
    setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/install-distro`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? "Установка запущена" : "Ошибка"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Сеть недоступна");
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const installDeps = async () => {
    setInstalling("deps");
    setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? "Готово" : "Ошибка"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Сеть недоступна");
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const fixDns = async () => {
    setInstalling("dns");
    setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/fix-dns`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? "DNS починен — WSL перезапущен" : "Ошибка"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Сеть недоступна");
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const wslOk = !!status?.wsl_installed && !!status?.distro_running;
  const psOk = !!status?.powershell_available;
  const activeShell = status?.active_shell ?? (preference === "powershell" ? "powershell" : "wsl");

  return (
    <section>
      <div className="st2-mh">
        <span className="st2-mn">04</span>
        <h2>Терминал</h2>
      </div>
      <p className="st2-md">
        Через какой шелл агент выполняет команды. По умолчанию — bash внутри WSL,
        с автоматическим откатом на Windows PowerShell, если WSL не установлен.
      </p>

      <div className="st2-mrows">
        {/* Status grid */}
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            <div className="st2-shell-grid">
              <ShellStatusCard
                title="WSL · bash"
                ok={wslOk}
                lines={[
                  status
                    ? status.wsl_installed
                      ? `wsl.exe найден${status.default_distro ? ` · ${status.default_distro}` : ""}`
                      : "wsl.exe не установлен"
                    : "—",
                  status?.wsl_installed
                    ? status.distro_running
                      ? "Дистрибутив запускается"
                      : "Дистрибутив недоступен"
                    : "",
                  status?.distro_running
                    ? [
                        status.node ? "node ✓" : "node ✗",
                        status.python ? "python3 ✓" : "python3 ✗",
                        status.npm ? "npm ✓" : "npm ✗",
                        status.pandoc ? "pandoc ✓" : "pandoc ✗",
                        status.dns_ok ? "DNS ✓" : "DNS ✗",
                      ].join(" · ")
                    : "",
                ].filter(Boolean)}
                active={activeShell === "wsl"}
              />
              <ShellStatusCard
                title="Windows PowerShell"
                ok={psOk}
                lines={[
                  status
                    ? status.powershell_available
                      ? "powershell.exe найден"
                      : "powershell.exe не найден"
                    : "—",
                  "Без bwrap-cage — песочница «мягкая»",
                ]}
                active={activeShell === "powershell"}
              />
            </div>
          </div>
        </div>

        {/* Preference picker */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t">Какой шелл использовать</p>
            <p className="d">
              «Авто» — bash в WSL, при ошибке откат на PowerShell. «Только WSL» —
              падать с ошибкой, если WSL недоступен. «Только PowerShell» —
              никогда не звать WSL.
            </p>
          </div>
          <div className="st2-mctl">
            <div className="st2-theme">
              <button
                className={preference === "auto" ? "active" : ""}
                onClick={() => onChange("auto")}
              >
                <Terminal /> Авто
              </button>
              <button
                className={preference === "wsl" ? "active" : ""}
                onClick={() => onChange("wsl")}
              >
                <Terminal /> WSL
              </button>
              <button
                className={preference === "powershell" ? "active" : ""}
                onClick={() => onChange("powershell")}
              >
                <Terminal /> PowerShell
              </button>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                className="st2-btn"
                onClick={installDistro}
                disabled={installing !== null}
                title="Запускает `wsl --install -d Ubuntu` с правами администратора"
              >
                {installing === "distro" ? "Установка…" : "Установить WSL + Ubuntu"}
              </button>
              <button
                className="st2-btn"
                onClick={installDeps}
                disabled={installing !== null || !status?.distro_running}
                title="Ставит nodejs, python3, npm, pandoc и docx внутри WSL. Сам чинит DNS, если он сломан."
              >
                {installing === "deps" ? "Установка…" : "Установить Node + Python + pandoc"}
              </button>
              {status?.distro_running && !status.dns_ok && (
                <button
                  className="st2-btn"
                  onClick={fixDns}
                  disabled={installing !== null}
                  title="Прописывает Cloudflare/Google DNS в /etc/resolv.conf и блокирует автогенерацию через /etc/wsl.conf, затем wsl --shutdown"
                >
                  {installing === "dns" ? "Чиню…" : "Починить DNS"}
                </button>
              )}
              <button
                className="st2-btn st2-btn--ghost"
                onClick={reload}
                disabled={loading}
              >
                <ArrowClockwise /> {loading ? "Проверяю…" : "Проверить снова"}
              </button>
              {!wslOk && psOk && preference !== "powershell" && (
                <button
                  className="st2-btn"
                  onClick={() => onChange("powershell")}
                  title="WSL недоступен — переключиться на Windows PowerShell"
                >
                  Перейти на PowerShell
                </button>
              )}
            </div>
            {message && (
              <pre className="st2-shell-msg">{message}</pre>
            )}
            {activeShell === "powershell" && (
              <div className="st2-risk-note" style={{ marginTop: 10 }}>
                <b>Режим PowerShell.</b> bwrap-песочница на Windows недоступна —
                модель ограничена только папкой чата через проверки путей,
                kernel-level изоляции нет.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ShellStatusCard({
  title,
  ok,
  lines,
  active,
}: {
  title: string;
  ok: boolean;
  lines: string[];
  active: boolean;
}) {
  return (
    <div className={`st2-shell-card${active ? " active" : ""}${ok ? " ok" : " bad"}`}>
      <div className="st2-shell-card-h">
        {ok ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
        <span className="st2-shell-card-title">{title}</span>
        {active && <span className="st2-shell-card-active">активен</span>}
      </div>
      {lines.map((ln, i) => (
        <div key={i} className="st2-shell-card-ln">{ln}</div>
      ))}
    </div>
  );
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

/* ── Skills Tab ──────────────────── */

interface SkillInfo {
  name: string;
  description: string;
  version: string;
  author: string;
}

interface SkillContent {
  name: string;
  content: string;
}

interface SkillFile {
  path: string;
  name: string;
  depth: number;
  is_dir: boolean;
  size: number;
}

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} кб`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} мб`;
}

function fileExtClass(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (name === "SKILL.md" || ext === "md") return "md";
  if (ext === "py") return "py";
  return "";
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const BADGE_COLORS = ["bg-1", "bg-2", "bg-3", "bg-4", "bg-5", "bg-6"];

function getBadgeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(h) % BADGE_COLORS.length]!;
}

function fmtSource(name: string): string | null {
  const parts = name.split("/");
  if (parts.length === 2) return name;
  return null;
}

function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const [files, setFiles] = useState<Map<string, SkillFile[]>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/skills`);
      if (res.ok) setSkills(await res.json());
    } catch { /* */ }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".st2-sk-menu")) setMenuOpen(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const isUrlValid = (v: string): boolean => {
    return /github\.com|^[\w-]+\/[\w.-]+$|\.skill$|^https?:\/\//.test(v);
  };

  const uploadSkillFile = async (f: File) => {
    if (!/\.(skill|zip)$/i.test(f.name)) {
      setError("Поддерживаются файлы .skill и .zip");
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch(`${API_BASE}/skills/install-file`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? "Install failed");
      }
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    const f = dropped.find((x) => /\.(skill|zip)$/i.test(x.name)) ?? dropped[0];
    if (f) await uploadSkillFile(f);
  };

  const handleInstall = async (sourceOverride?: string) => {
    const trimmed = (sourceOverride ?? source).trim();
    if (!trimmed) return;
    setInstalling(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? "Install failed");
      }
      if (!sourceOverride) setSource("");
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (name: string) => {
    setError(null);
    setMenuOpen(null);
    try {
      await fetch(`${API_BASE}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      setContents((prev) => { const m = new Map(prev); m.delete(name); return m; });
      setFiles((prev) => { const m = new Map(prev); m.delete(name); return m; });
      await fetchSkills();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const handleExpand = async (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    const needContent = !contents.has(name);
    const needFiles = !files.has(name);
    const enc = encodeURIComponent(name);
    await Promise.all([
      needContent ? fetch(`${API_BASE}/skills/${enc}/read`).then(async (res) => {
        if (res.ok) {
          const data: SkillContent = await res.json();
          setContents((prev) => { const m = new Map(prev); m.set(name, data.content); return m; });
        }
      }).catch(() => {}) : Promise.resolve(),
      needFiles ? fetch(`${API_BASE}/skills/${enc}/files`).then(async (res) => {
        if (res.ok) {
          const data: SkillFile[] = await res.json();
          setFiles((prev) => { const m = new Map(prev); m.set(name, data); return m; });
        }
      }).catch(() => {}) : Promise.resolve(),
    ]);
  };

  const filtered = skills.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  const valid = !!source.trim() && isUrlValid(source.trim()) && source.trim().length > 3;

  return (
    <div
      className={`st2-main${isDragging ? " is-dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="st2-sk-drop-overlay">
          <div className="st2-sk-drop-card">
            <div className="st2-sk-drop-icon"><Plus /></div>
            <div className="st2-sk-drop-title">Отпустите чтобы установить</div>
            <div className="st2-sk-drop-hint">Поддерживается <b>.skill</b> и <b>.zip</b></div>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".skill,.zip,application/zip"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadSkillFile(f);
          e.target.value = "";
        }}
      />
      <h3 className="st2-h">Скиллы</h3>
      <p className="st2-sub">
        Расширяют возможности модели. Манифест пересобирается автоматически при изменениях в папке скиллов.
      </p>

      {/* 01 Добавить скилл */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>Добавить скилл</h2>
        </div>
        <p className="st2-md">
          Вставьте ссылку — на GitHub-репозиторий, <code>.skill</code>-архив или любой URL, отдающий <code>SKILL.md</code>.
        </p>

        <div className="st2-sk-install">
          <div className={`st2-sk-input${valid ? " detected" : ""}`}>
            <span className="lead"><LinkSimple size={14} weight="bold" /></span>
            <input
              ref={inputRef}
              type="text"
              placeholder="github.com/owner/repo · https://… · path/to/skill.zip"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !installing && valid && handleInstall()}
              disabled={installing}
            />
            <span className="ok">✓ найден</span>
          </div>
          <button
            className="st2-sk-install-btn primary"
            onClick={() => handleInstall()}
            disabled={installing || !valid}
          >
            <Plus /> Установить
          </button>
        </div>

        <div className="st2-sk-hints">
          <span>понимаем: <b>owner/repo</b></span>
          <span><b>https://github.com/…</b></span>
          <button
            type="button"
            className="st2-sk-hint-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={installing}
          >
            или выбрать <b>.skill</b> / <b>.zip</b>
          </button>
          <span>· перетащите файл сюда</span>
        </div>

        <div className="st2-sk-preset">
          <div className="st2-sk-preset-info">
            <div className="st2-sk-preset-title">Набор от Anthropic</div>
            <div className="st2-sk-preset-desc">
              Word, Excel, PowerPoint, PDF, создание скиллов — официальная коллекция из <code>github.com/anthropics/skills</code>.
            </div>
          </div>
          <button
            className="st2-sk-install-btn"
            onClick={() => handleInstall("anthropics/skills")}
            disabled={installing}
          >
            {installing ? "Установка…" : <><Plus /> Установить набор</>}
          </button>
        </div>

        {installing && (
          <div className="st2-sk-error" style={{ marginTop: 12 }}>Установка…</div>
        )}
        {error && <div className="st2-sk-error">{error}</div>}
      </section>

      {/* 02 Установленные */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>Установленные</h2>
        </div>
        <p className="st2-md">
          Клик по строке — раскрывает SKILL.md. Меню справа — удалить.
        </p>

        <div className="st2-mrows">
          <div className="st2-sk-search">
            <div className="fld">
              <MagnifyingGlass />
              <input
                placeholder="Поиск по имени или описанию…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="st2-sk-meta">
              <b>{skills.length}</b> установлено
            </div>
          </div>

          {filtered.map((s) => {
            const isExpanded = expanded === s.name;
            const src = fmtSource(s.name);
            const content = contents.get(s.name);
            const tree = files.get(s.name);
            return (
              <div key={s.name}>
                <div
                  className={`st2-sk-item${isExpanded ? " open" : ""}`}
                  onClick={() => handleExpand(s.name)}
                >
                  <div className={`st2-sk-badge ${getBadgeColor(s.name)}`}>
                    {s.name[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="st2-sk-info">
                    <div className="st2-sk-name">
                      {s.name}
                      {s.version && <span className="v">v{s.version}</span>}
                    </div>
                    {s.description && <div className="st2-sk-desc">{s.description}</div>}
                  </div>
                  <div
                    className="st2-sk-menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(menuOpen === s.name ? null : s.name);
                    }}
                  >
                    <DotsThree />
                    {menuOpen === s.name && (
                      <div className="st2-sk-popover">
                        <div className="pitem" onClick={(e) => { e.stopPropagation(); handleUninstall(s.name); }}>
                          <Trash /> Удалить
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="st2-sk-chev"><CaretDown /></span>
                </div>

                {isExpanded && (
                  <div className="st2-sk-body">
                    <div className="grid">
                      <div>
                        <h6 className="col-label">
                          Структура
                          <span className="src">~/skills/{s.name}</span>
                        </h6>
                        {tree ? (
                          <SkillTree files={tree} />
                        ) : (
                          <div className="st2-sk-tree"><div className="ln" style={{ color: "var(--faint)" }}>Загрузка…</div></div>
                        )}
                      </div>
                      <div>
                        <h6 className="col-label">
                          SKILL.md
                          {src && <span className="src">· {src}</span>}
                        </h6>
                        {content ? (
                          <Markdown
                            text={content}
                            className="st2-sk-readme"
                            stripFrontmatter
                            breaks={false}
                          />
                        ) : (
                          <div className="st2-sk-readme" style={{ color: "var(--faint)" }}>Загрузка…</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="st2-sk-empty">
              {search ? "Ничего не найдено" : "Нет установленных скиллов"}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Flat directory listing rendered with depth-based indent, matching the
 * reference design (~/skills/<name>/ tree). */
function SkillTree({ files }: { files: SkillFile[] }) {
  if (files.length === 0) {
    return <div className="st2-sk-tree"><div className="ln" style={{ color: "var(--faint)" }}>Пусто</div></div>;
  }
  return (
    <div className="st2-sk-tree">
      {files.map((f) => {
        const indents = Array.from({ length: f.depth });
        const cls = f.is_dir ? "dir" : fileExtClass(f.name);
        return (
          <div className="ln" key={f.path || `__root__/${f.name}`} title={f.path || f.name}>
            {indents.map((_, i) => <span className="indent" key={i} />)}
            <span className={`ic ${cls}`}>{f.is_dir ? "▾" : cls === "md" ? "¶" : "·"}</span>
            <span className={`nm ${cls}`}>{f.name}{f.is_dir ? "/" : ""}</span>
            {!f.is_dir && f.size > 0 && <span className="sz">{fmtFileSize(f.size)}</span>}
            {f.is_dir && f.size > 0 && <span className="sz">{f.size} {pluralRu(f.size, "файл", "файла", "файлов")}</span>}
          </div>
        );
      })}
    </div>
  );
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

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const [checking, setChecking] = useState(false);

  const handleCheckUpdate = async () => {
    if (checking) return;
    setChecking(true);
    await checkForUpdates((status) => {
      setUpdateStatus(status);
      if (status.state === "latest" || status.state === "error" || status.state === "installing") {
        setChecking(false);
      }
    });
  };

  const renderUpdateStatus = () => {
    switch (updateStatus.state) {
      case "checking":
        return (
          <div className="st2-update-status">
            <ArrowClockwise className="spin" /> Проверяю обновления...
          </div>
        );
      case "available":
        return (
          <div className="st2-update-status st2-update-available">
            <WarningCircle /> Доступна версия <b>v{updateStatus.version}</b>
          </div>
        );
      case "downloading":
        return (
          <div className="st2-update-status">
            <ArrowClockwise className="spin" /> Загрузка обновления...
          </div>
        );
      case "installing":
        return (
          <div className="st2-update-status">
            <ArrowClockwise className="spin" /> Установка... Перезапустите приложение.
          </div>
        );
      case "latest":
        return (
          <div className="st2-update-status st2-update-latest">
            <CheckCircle /> Установлена последняя версия
          </div>
        );
      case "error":
        return (
          <div className="st2-update-status st2-update-error">
            <WarningCircle /> {updateStatus.message}
          </div>
        );
      default:
        return null;
    }
  };

  return <>
    <h3 className="st2-h">О приложении</h3>
    <p className="st2-sub">
      AgentChat — десктопный чат для рабочих задач и брейншторминга.<br />
      Локальный, конфиденциальный, без привязки к редактированию кода.
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
      <div className="st2-about-version">
        <div className="st2-about-author" style={{ gap: 12 }}>
          <img src="/dots.svg" alt="" style={{ width: 36, height: 36, borderRadius: 7 }} />
          <div>
            <span className="st2-about-author-name">AgentChat</span>
            <span className="st2-about-author-meta">v{pkg.version}</span>
          </div>
        </div>
        {isTauri() && (
          <div className="st2-update-row">
            <button
              className="st2-btn st2-btn--ghost"
              onClick={handleCheckUpdate}
              disabled={checking}
            >
              <ArrowClockwise /> {checking ? "Проверяю..." : "Проверить обновления"}
            </button>
            {renderUpdateStatus()}
          </div>
        )}
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
        Чат, в котором можно обсудить рабочий вопрос, набросать идею,
        разобрать проблему — и не улетать в среду разработки. Никакого
        скрытого запуска скриптов, никакой магии терминала. Просто диалог.
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
