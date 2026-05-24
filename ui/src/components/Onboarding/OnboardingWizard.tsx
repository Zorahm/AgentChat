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
  libreoffice: string | null;
  poppler: boolean;
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

  // ── Step 3: WSL — single button installs distro + libraries ──

  const appendLog = (line: string) => setWslLog((prev) => (prev ? prev + "\n" + line : line));

  /** Poll /wsl/status until distro_running is true, or give up. */
  const pollDistroReady = async (timeoutMs = 600000): Promise<WSLStatus | null> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const r = await fetch(`${API_BASE}/wsl/status`);
        if (r.ok) {
          const s = (await r.json()) as WSLStatus;
          setWsl(s);
          if (s.distro_running) return s;
        }
      } catch {
        /* keep polling */
      }
    }
    return null;
  };

  /** Single-click flow: ensure WSL+Ubuntu installed, then libraries. */
  const installAll = async () => {
    setWslBusy("all");
    setWslLog("");
    setError(null);
    try {
      let current = wsl;
      if (!current || !current.wsl_installed || !current.distro_running) {
        if (!current || !current.wsl_installed || !current.default_distro) {
          appendLog("Запускаю установку WSL + Ubuntu (потребуется UAC)…");
          const r = await fetch(`${API_BASE}/wsl/install-distro`, { method: "POST" });
          const d = await r.json();
          if (d.output) appendLog(d.output);
          if (!d.success) throw new Error("Не удалось запустить установку WSL");
        }
        appendLog("Жду готовности дистрибутива (первый запуск может занять до 10 минут)…");
        const ready = await pollDistroReady();
        if (!ready) throw new Error("WSL не запустился за 10 минут — попробуй вручную через PowerShell");
        current = ready;
      }

      appendLog("Устанавливаю Node, Python, pandoc, LibreOffice, poppler-utils, docx…");
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.output ?? "Не удалось запустить установку");

      // Poll the background install task — backend updates _install_log as apt progresses.
      let lastLog = "";
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const s = await fetch(`${API_BASE}/wsl/install-deps/status`);
          if (!s.ok) continue;
          const p = await s.json() as { running: boolean; log: string; error: string | null };
          if (p.log && p.log !== lastLog) {
            lastLog = p.log;
            setWslLog(p.log);
          }
          if (!p.running) {
            if (p.error) throw new Error(p.error);
            break;
          }
        } catch (err) {
          if (err instanceof Error && err.message) throw err;
          /* transient network error — keep polling */
        }
      }
      appendLog("✓ Готово");
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
            <h3>WSL и системные библиотеки</h3>
            <p className="ob-sub">
              Bash-инструмент агента работает внутри WSL. Один клик ставит Ubuntu и весь набор
              библиотек для офисных форматов: Node.js, Python 3, <code>pandoc</code>,
              <code> LibreOffice</code>, <code>poppler-utils</code> и npm-пакет <code>docx</code>.
            </p>

            {wsl === null ? (
              <p className="ob-sub2">Проверяю состояние WSL…</p>
            ) : (
              <div className="ob-wsl-grid">
                <WSLRow label="WSL + дистрибутив" ok={wsl.wsl_installed && wsl.distro_running}
                  value={wsl.distro_running ? (wsl.default_distro ?? "запущен") : wsl.wsl_installed ? "не запускается" : "не установлен"} />
                <WSLRow label="Node.js" ok={!!wsl.node} value={wsl.node ?? "—"} />
                <WSLRow label="Python 3" ok={!!wsl.python} value={wsl.python ?? "—"} />
                <WSLRow label="pandoc" ok={!!wsl.pandoc} value={wsl.pandoc ?? "—"} />
                <WSLRow label="LibreOffice" ok={!!wsl.libreoffice} value={wsl.libreoffice ?? "—"} />
                <WSLRow label="poppler-utils" ok={wsl.poppler} value={wsl.poppler ? "установлен" : "—"} />
                <WSLRow label="docx (npm -g)" ok={wsl.docx} value={wsl.docx ? "установлен" : "—"} />
                <WSLRow label="DNS" ok={wsl.dns_ok} value={wsl.dns_ok ? "работает" : "сломан (починю при установке)"} />
              </div>
            )}

            {(() => {
              if (!wsl) return null;
              const allOk = wsl.wsl_installed && wsl.distro_running && !!wsl.node && !!wsl.python
                && !!wsl.npm && !!wsl.pandoc && !!wsl.libreoffice && wsl.poppler && wsl.docx;
              return (
                <div className="ob-wsl-actions">
                  {!allOk && (
                    <button className="ob-btn" onClick={installAll} disabled={wslBusy !== null}>
                      {wslBusy === "all" ? "Установка…" : "Установить WSL"}
                    </button>
                  )}
                  {allOk && <span className="ob-success">Всё на месте.</span>}
                  <button className="ob-btn ob-btn--ghost" onClick={refreshWsl} disabled={wslBusy !== null}>
                    Проверить ещё раз
                  </button>
                </div>
              );
            })()}

            {wslLog && (
              <pre className="ob-log">{wslLog}</pre>
            )}

            <div className="ob-actions" style={{ marginTop: 24 }}>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(2)}>Назад</button>
              <button className="ob-btn" onClick={() => setStep(4)} disabled={wslBusy !== null}>Далее</button>
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
