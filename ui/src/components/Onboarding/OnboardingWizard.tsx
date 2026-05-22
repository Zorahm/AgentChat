/** Onboarding wizard — first-run setup: name → provider/model → WSL. */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../../utils/apiBase";

interface ProviderConfig {
  id: string;
  name: string;
  api_key: string | null;
  api_base: string | null;
  enabled: boolean;
  api_key_set: boolean;
  custom?: boolean;
}

interface ModelConfig {
  id: string;
  name?: string | null;
}

interface WSLStatus {
  wsl_installed: boolean;
  default_distro: string | null;
  distro_running: boolean;
  node: string | null;
  python: string | null;
  npm: string | null;
  pandoc: string | null;
  docx: boolean;
  dns_ok: boolean;
}

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 1 | 2 | 3 | 4;

const ANTHROPIC_SKILLS_SOURCE = "anthropics/skills";

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [userName, setUserName] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [wsl, setWsl] = useState<WSLStatus | null>(null);
  const [wslBusy, setWslBusy] = useState<string | null>(null);
  const [wslLog, setWslLog] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillsInstalling, setSkillsInstalling] = useState(false);
  const [skillsInstalled, setSkillsInstalled] = useState<number | null>(null);

  // Initial load: fetch providers list
  useEffect(() => {
    fetch(`${API_BASE}/settings`)
      .then((r) => r.json())
      .then((d) => {
        setProviders(d.providers ?? []);
        if (typeof d.user_name === "string") setUserName(d.user_name);
        if (d.providers?.length && !selectedProvider) {
          setSelectedProvider(d.providers[0].id);
        }
      })
      .catch(() => setError("Не удалось подключиться к бэкенду"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshModels = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/models?refresh=true`);
      if (r.ok) {
        const d = await r.json();
        setModels(d.models ?? []);
      }
    } catch {
      /* no-op */
    }
  }, []);

  const refreshWsl = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/wsl/status`);
      if (r.ok) {
        const d = (await r.json()) as WSLStatus;
        setWsl(d);
      }
    } catch {
      setWsl(null);
    }
  }, []);

  useEffect(() => {
    if (step === 3) refreshWsl();
  }, [step, refreshWsl]);

  // ── Step 1: name ──
  const handleNextFromName = async () => {
    setError(null);
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_name: userName.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  // ── Step 2: provider + key + model ──
  const handleSaveKey = async () => {
    if (!selectedProvider || !apiKey.trim()) {
      setError("Выберите провайдера и введите ключ");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/settings/providers/${selectedProvider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey.trim(), enabled: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setApiKey("");
      await refreshModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить ключ");
    } finally {
      setSaving(false);
    }
  };

  const handleNextFromProvider = async () => {
    if (!defaultModel) {
      setError("Выберите модель по умолчанию");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_model: defaultModel }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  // ── Step 3: WSL ──
  const installDistro = async () => {
    setWslBusy("distro");
    setWslLog("");
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/install-distro`, { method: "POST" });
      const d = await r.json();
      setWslLog(d.output ?? "");
      if (!d.success) setError("Не удалось запустить установку дистрибутива");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Сетевая ошибка");
    } finally {
      setWslBusy(null);
      setTimeout(refreshWsl, 1000);
    }
  };

  const installDeps = async () => {
    setWslBusy("deps");
    setWslLog("Идёт установка пакетов в WSL (apt + npm). Это может занять несколько минут…");
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const d = await r.json();
      setWslLog(d.output ?? "");
      if (!d.success) setError("Не удалось установить пакеты");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Сетевая ошибка");
    } finally {
      setWslBusy(null);
      await refreshWsl();
    }
  };

  const fixDns = async () => {
    setWslBusy("dns");
    setWslLog("Чиню DNS внутри WSL (resolv.conf + wsl.conf), перезапускаю дистрибутив…");
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/fix-dns`, { method: "POST" });
      const d = await r.json();
      setWslLog(d.output ?? "");
      if (!d.success) setError("Не удалось починить DNS — см. лог");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Сетевая ошибка");
    } finally {
      setWslBusy(null);
      await refreshWsl();
    }
  };

  const installAnthropicSkills = async () => {
    setSkillsInstalling(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: ANTHROPIC_SKILLS_SOURCE }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? `HTTP ${r.status}`);
      setSkillsInstalled(Array.isArray(d) ? d.length : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось установить");
    } finally {
      setSkillsInstalling(false);
    }
  };

  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboarding_completed: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось завершить");
      setSaving(false);
    }
  };

  const selectedProviderObj = providers.find((p) => p.id === selectedProvider);
  const providerModels = models.filter((m) => m.id.startsWith(selectedProvider + "/"));

  return (
    <div className="ob-overlay">
      <div className="ob-card">
        <div className="ob-header">
          <h2>Добро пожаловать в AgentChat</h2>
          <div className="ob-steps">
            <span className={step === 1 ? "active" : step > 1 ? "done" : ""}>1 · Имя</span>
            <span className={step === 2 ? "active" : step > 2 ? "done" : ""}>2 · Провайдер</span>
            <span className={step === 3 ? "active" : step > 3 ? "done" : ""}>3 · WSL</span>
            <span className={step === 4 ? "active" : ""}>4 · Скиллы</span>
          </div>
        </div>

        {error && <div className="ob-error">{error}</div>}

        {step === 1 && (
          <div className="ob-body">
            <h3>Как к вам обращаться?</h3>
            <p className="ob-sub">Имя будет передано модели в системном промпте.</p>
            <input
              autoFocus
              className="ob-input"
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Имя"
              onKeyDown={(e) => e.key === "Enter" && handleNextFromName()}
            />
            <div className="ob-actions">
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(2)}>Пропустить</button>
              <button className="ob-btn" onClick={handleNextFromName} disabled={saving}>
                {saving ? "Сохраняю…" : "Далее"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="ob-body">
            <h3>Подключите провайдера и выберите модель</h3>
            <p className="ob-sub">Введите API-ключ хотя бы одного провайдера. Список моделей обновится автоматически.</p>

            <label className="ob-label">Провайдер</label>
            <select
              className="ob-select"
              value={selectedProvider}
              onChange={(e) => { setSelectedProvider(e.target.value); setDefaultModel(""); }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.api_key_set ? " ✓" : ""}
                </option>
              ))}
            </select>

            <label className="ob-label" style={{ marginTop: 12 }}>
              API ключ {selectedProviderObj?.api_key_set ? "(уже установлен — можно перезаписать)" : ""}
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="ob-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selectedProviderObj?.api_key_set ? "•••• новый ключ" : "sk-…"}
                style={{ flex: 1 }}
              />
              <button className="ob-btn" onClick={handleSaveKey} disabled={saving || !apiKey.trim()}>
                Сохранить ключ
              </button>
            </div>

            <label className="ob-label" style={{ marginTop: 16 }}>
              Модель по умолчанию
              <button
                className="ob-btn ob-btn--ghost ob-btn--small"
                onClick={refreshModels}
                style={{ marginLeft: 8 }}
              >
                Обновить
              </button>
            </label>
            <select
              className="ob-select"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            >
              <option value="">— выберите —</option>
              {providerModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
              ))}
            </select>
            {providerModels.length === 0 && (
              <p className="ob-sub2">Список пуст. Сохраните ключ и нажмите «Обновить».</p>
            )}

            <div className="ob-actions">
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(1)}>Назад</button>
              <button className="ob-btn" onClick={handleNextFromProvider} disabled={saving}>
                {saving ? "…" : "Далее"}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="ob-body">
            <h3>WSL (Windows Subsystem for Linux)</h3>
            <p className="ob-sub">
              Bash-инструмент агента работает внутри WSL. Нужны: Ubuntu (или другой дистрибутив),
              Node.js, Python 3, <code>pandoc</code> (для чтения .docx/.odt/.rtf) и npm-пакет <code>docx</code> (для генерации).
              Остальные пакеты модель установит при необходимости.
            </p>

            {wsl === null ? (
              <p className="ob-sub2">Проверяю состояние WSL…</p>
            ) : (
              <div className="ob-wsl-grid">
                <WSLRow label="WSL установлен" ok={wsl.wsl_installed} value={wsl.wsl_installed ? "да" : "нет"} />
                <WSLRow label="Дистрибутив" ok={!!wsl.default_distro} value={wsl.default_distro ?? "не найден"} />
                <WSLRow label="Дистрибутив запускается" ok={wsl.distro_running} value={wsl.distro_running ? "да" : "нет"} />
                <WSLRow label="Node.js" ok={!!wsl.node} value={wsl.node ?? "не установлен"} />
                <WSLRow label="Python 3" ok={!!wsl.python} value={wsl.python ?? "не установлен"} />
                <WSLRow label="npm" ok={!!wsl.npm} value={wsl.npm ?? "не установлен"} />
                <WSLRow label="pandoc" ok={!!wsl.pandoc} value={wsl.pandoc ?? "не установлен"} />
                <WSLRow label="docx (npm -g)" ok={wsl.docx} value={wsl.docx ? "установлен" : "нет"} />
                <WSLRow label="DNS" ok={wsl.dns_ok} value={wsl.dns_ok ? "работает" : "сломан (apt/pip упадут)"} />
              </div>
            )}

            <div className="ob-wsl-actions">
              {wsl && (!wsl.wsl_installed || !wsl.default_distro) && (
                <button className="ob-btn" onClick={installDistro} disabled={wslBusy !== null}>
                  {wslBusy === "distro" ? "Запуск…" : "Установить WSL + Ubuntu"}
                </button>
              )}
              {wsl && wsl.distro_running && !wsl.dns_ok && (
                <button className="ob-btn" onClick={fixDns} disabled={wslBusy !== null}>
                  {wslBusy === "dns" ? "Чиню…" : "Починить DNS в WSL"}
                </button>
              )}
              {wsl && wsl.distro_running && (!wsl.node || !wsl.python || !wsl.npm || !wsl.pandoc || !wsl.docx) && (
                <button className="ob-btn" onClick={installDeps} disabled={wslBusy !== null}>
                  {wslBusy === "deps" ? "Установка…" : "Установить Node + Python + pandoc + docx"}
                </button>
              )}
              <button className="ob-btn ob-btn--ghost" onClick={refreshWsl} disabled={wslBusy !== null}>
                Проверить ещё раз
              </button>
            </div>

            {wslLog && (
              <pre className="ob-log">{wslLog}</pre>
            )}

            <div className="ob-actions" style={{ marginTop: 24 }}>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(2)}>Назад</button>
              <button className="ob-btn" onClick={() => setStep(4)}>Далее</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="ob-body">
            <h3>Скиллы от Anthropic</h3>
            <p className="ob-sub">
              Готовый набор инструментов, расширяющий модель: создание документов и работа с офисными форматами.
            </p>
            <ul className="ob-bullets">
              <li><b>Word</b> (.docx) — отчёты, документы со стилями и таблицами</li>
              <li><b>Excel</b> (.xlsx) — таблицы, формулы, формат ячеек</li>
              <li><b>PowerPoint</b> (.pptx) — презентации со слайдами и шаблонами</li>
              <li><b>PDF</b> — генерация и парсинг</li>
              <li><b>Создание скиллов</b> — мета-скилл для написания своих</li>
            </ul>
            <p className="ob-sub2">
              Источник: <code>github.com/{ANTHROPIC_SKILLS_SOURCE}</code>. Установка займёт 10–30 секунд.
            </p>

            {skillsInstalled !== null && (
              <div className="ob-success">
                Установлено: <b>{skillsInstalled}</b> {skillsInstalled === 1 ? "скилл" : "скиллов"}.
              </div>
            )}

            <div className="ob-actions" style={{ marginTop: 24 }}>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(3)}>Назад</button>
              {skillsInstalled === null ? (
                <>
                  <button className="ob-btn ob-btn--ghost" onClick={finish} disabled={saving || skillsInstalling}>
                    Пропустить
                  </button>
                  <button className="ob-btn" onClick={installAnthropicSkills} disabled={skillsInstalling || saving}>
                    {skillsInstalling ? "Устанавливаю…" : "Установить"}
                  </button>
                </>
              ) : (
                <button className="ob-btn" onClick={finish} disabled={saving}>
                  {saving ? "Завершаю…" : "Готово"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WSLRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <>
      <span className="ob-wsl-label">{label}</span>
      <span className={`ob-wsl-value ${ok ? "ok" : "missing"}`}>
        <span className="ob-dot" />
        {value}
      </span>
    </>
  );
}
