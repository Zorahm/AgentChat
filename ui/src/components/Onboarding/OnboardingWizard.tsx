/** Onboarding wizard — first-run setup: name → provider/model → WSL. */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../../utils/apiBase";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(1);
  const [userName, setUserName] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [shellChoice, setShellChoice] = useState<"wsl" | "powershell" | null>(null);
  const [wsl, setWsl] = useState<WSLStatus | null>(null);
  const [wslBusy, setWslBusy] = useState<string | null>(null);
  const [wslLog, setWslLog] = useState<string>("");
  const [wslUsername, setWslUsername] = useState("");
  const [wslPassword, setWslPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillsInstalling, setSkillsInstalling] = useState(false);
  const [skillsInstalled, setSkillsInstalled] = useState<number | null>(null);
  // Host OS — gates the WSL step. On a native Linux/macOS host there's no
  // WSL/PowerShell choice, so the shell step is skipped entirely.
  const [osPlatform, setOsPlatform] = useState<string>("windows");
  const isWindows = osPlatform === "windows";

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
      .catch(() => setError(t("onboarding.connectionError")));
    // Cheap platform probe (no WSL spawning) so we know whether to show the
    // WSL setup step at all.
    fetch(`${API_BASE}/system-status`)
      .then((r) => r.json())
      .then((d) => { if (typeof d.os_platform === "string") setOsPlatform(d.os_platform); })
      .catch(() => {});
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
    if (step === 3 && shellChoice === "wsl") refreshWsl();
  }, [step, shellChoice, refreshWsl]);

  /** Step 3: pick the shell. WSL reveals its setup screen; PowerShell needs none. */
  const chooseShell = useCallback(
    async (choice: "wsl" | "powershell") => {
      setShellChoice(choice);
      setError(null);
      try {
        await fetch(`${API_BASE}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shell_preference: choice }),
        });
      } catch {
        /* non-critical — the selection still drives the UI */
      }
      if (choice === "wsl") refreshWsl();
    },
    [refreshWsl],
  );

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
      setError(e instanceof Error ? e.message : t("onboarding.saveError"));
    } finally {
      setSaving(false);
    }
  };

  // ── Step 2: provider + key + model ──
  const handleSaveKey = async () => {
    if (!selectedProvider || !apiKey.trim()) {
      setError(t("onboarding.validationProvider"));
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
      setError(e instanceof Error ? e.message : t("onboarding.keySaveError"));
    } finally {
      setSaving(false);
    }
  };

  const handleNextFromProvider = async () => {
    if (!defaultModel) {
      setError(t("onboarding.validationModel"));
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
      setStep(isWindows ? 3 : 4);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("onboarding.modelSaveError"));
    } finally {
      setSaving(false);
    }
  };

  // ── Step 3: WSL — single button installs distro + libraries ──

  const appendLog = (line: string) => setWslLog((prev) => (prev ? prev + "\n" + line : line));

  /** Single-click flow: ensure WSL+Ubuntu installed (+ Linux user), then libraries. */
  const installAll = async () => {
    const distroReady = !!wsl && wsl.wsl_installed && wsl.distro_running;
    // A fresh distro install needs Linux credentials so we can provision the
    // user ourselves (no interactive first-boot prompt).
    if (!distroReady && (!wslUsername.trim() || !wslPassword)) {
      setError(t("onboarding.wslCredsRequired"));
      return;
    }
    setWslBusy("all");
    setWslLog("");
    setError(null);
    try {
      if (!distroReady) {
        const r = await fetch(`${API_BASE}/wsl/install-distro`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: wslUsername.trim().toLowerCase(),
            password: wslPassword,
          }),
        });
        const d = await r.json();
        if (d.output) appendLog(d.output);
        if (!r.ok || !d.success) throw new Error(d.output ?? t("onboarding.wslStartError"));

        // Poll the background install/provision task. The backend enables the
        // Windows features via DISM on failure and reports a restart request.
        let lastLog = "";
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          try {
            const s = await fetch(`${API_BASE}/wsl/install-distro/status`);
            if (!s.ok) continue;
            const p = (await s.json()) as { running: boolean; log: string; error: string | null; done: boolean };
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
        await refreshWsl();
      }

      appendLog(t("onboarding.wslInstallingDeps"));
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.output ?? t("onboarding.wslInstallError"));

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
      appendLog(t("onboarding.wslDone"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("onboarding.networkError"));
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
      setError(e instanceof Error ? e.message : t("onboarding.skillsError"));
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
      setError(e instanceof Error ? e.message : t("onboarding.completeError"));
      setSaving(false);
    }
  };

  const selectedProviderObj = providers.find((p) => p.id === selectedProvider);
  const providerModels = models.filter((m) => m.id.startsWith(selectedProvider + "/"));

  return (
    <div className="ob-overlay">
      <div className="ob-card">
        <div className="ob-header">
          <h2>{t("onboarding.welcome")}</h2>
          <div className="ob-steps">
            <span className={step === 1 ? "active" : step > 1 ? "done" : ""}>{t("onboarding.stepName")}</span>
            <span className={step === 2 ? "active" : step > 2 ? "done" : ""}>{t("onboarding.stepProvider")}</span>
            {isWindows && (
              <span className={step === 3 ? "active" : step > 3 ? "done" : ""}>{t("onboarding.stepWsl")}</span>
            )}
            <span className={step === 4 ? "active" : ""}>{t("onboarding.stepSkills")}</span>
          </div>
        </div>

        {error && <div className="ob-error">{error}</div>}

        {step === 1 && (
          <div className="ob-body">
            <h3>{t("onboarding.step1Title")}</h3>
            <p className="ob-sub">{t("onboarding.step1Description")}</p>
            <input
              autoFocus
              className="ob-input"
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder={t("onboarding.step1Placeholder")}
              onKeyDown={(e) => e.key === "Enter" && handleNextFromName()}
            />
            <div className="ob-actions">
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(2)}>{t("onboarding.skip")}</button>
              <button className="ob-btn" onClick={handleNextFromName} disabled={saving}>
                {saving ? t("onboarding.saving") : t("onboarding.next")}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="ob-body">
            <h3>{t("onboarding.step2Title")}</h3>
            <p className="ob-sub">{t("onboarding.step2Description")}</p>

            <label className="ob-label">{t("onboarding.step2Provider")}</label>
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
              {t("onboarding.step2ApiKey")} {selectedProviderObj?.api_key_set ? `(${t("onboarding.step2ApiKeyHint")})` : ""}
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="ob-input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selectedProviderObj?.api_key_set ? t("onboarding.step2ApiKeyNewPlaceholder") : t("onboarding.step2ApiKeyPlaceholder")}
                style={{ flex: 1 }}
              />
              <button className="ob-btn" onClick={handleSaveKey} disabled={saving || !apiKey.trim()}>
                {t("onboarding.step2SaveKey")}
              </button>
            </div>

            <label className="ob-label" style={{ marginTop: 16 }}>
              {t("onboarding.step2DefaultModel")}
              <button
                className="ob-btn ob-btn--ghost ob-btn--small"
                onClick={refreshModels}
                style={{ marginLeft: 8 }}
              >
                {t("onboarding.step2Refresh")}
              </button>
            </label>
            <select
              className="ob-select"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            >
              <option value="">{t("onboarding.step2SelectModel")}</option>
              {providerModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
              ))}
            </select>
            {providerModels.length === 0 && (
              <p className="ob-sub2">{t("onboarding.step2NoModels")}</p>
            )}

            <div className="ob-actions">
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(1)}>{t("onboarding.back")}</button>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(isWindows ? 3 : 4)}>{t("onboarding.skip")}</button>
              <button className="ob-btn" onClick={handleNextFromProvider} disabled={saving}>
                {saving ? "…" : t("onboarding.next")}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="ob-body">
            <h3>{t("onboarding.step3Title")}</h3>
            <p className="ob-sub">
              {t("onboarding.step3Description")}
            </p>

            <div className="ob-shell-choice">
              <button
                type="button"
                className={`ob-shell-card${shellChoice === "powershell" ? " selected" : ""}`}
                onClick={() => chooseShell("powershell")}
              >
                <span className="ob-shell-name">{t("onboarding.shellPowershell")}</span>
                <span className="ob-shell-desc">{t("onboarding.shellPowershellDesc")}</span>
              </button>
              <button
                type="button"
                className={`ob-shell-card${shellChoice === "wsl" ? " selected" : ""}`}
                onClick={() => chooseShell("wsl")}
              >
                <span className="ob-shell-name">{t("onboarding.shellWsl")}</span>
                <span className="ob-shell-desc">{t("onboarding.shellWslDesc")}</span>
              </button>
            </div>

            {shellChoice === "powershell" && (
              <p className="ob-sub2">{t("onboarding.shellPowershellNote")}</p>
            )}

            {shellChoice === "wsl" && (
            <>
            {wsl === null ? (
              <p className="ob-sub2">{t("onboarding.checkingWsl")}</p>
            ) : (
              <div className="ob-wsl-grid">
                <WSLRow label={t("onboarding.wslDistro")} ok={wsl.wsl_installed && wsl.distro_running}
                  value={wsl.distro_running ? (wsl.default_distro ?? t("onboarding.wslRunning")) : wsl.wsl_installed ? t("onboarding.wslNotRunning") : t("onboarding.wslNotInstalled")} />
                <WSLRow label={t("onboarding.wslNode")} ok={!!wsl.node} value={wsl.node ?? "—"} />
                <WSLRow label={t("onboarding.wslPython")} ok={!!wsl.python} value={wsl.python ?? "—"} />
                <WSLRow label={t("onboarding.wslPandoc")} ok={!!wsl.pandoc} value={wsl.pandoc ?? "—"} />
                <WSLRow label={t("onboarding.wslLibreOffice")} ok={!!wsl.libreoffice} value={wsl.libreoffice ?? "—"} />
                <WSLRow label={t("onboarding.wslPoppler")} ok={wsl.poppler} value={wsl.poppler ? t("onboarding.wslPoppler") : "—"} />
                <WSLRow label={t("onboarding.wslDocx")} ok={wsl.docx} value={wsl.docx ? t("onboarding.wslDocx") : "—"} />
                <WSLRow label={t("onboarding.wslDns")} ok={wsl.dns_ok} value={wsl.dns_ok ? t("onboarding.wslDnsWorking") : t("onboarding.wslDnsBroken")} />
              </div>
            )}

            {wsl && !wsl.distro_running && (
              <div className="ob-wsl-creds">
                <p className="ob-sub2">{t("onboarding.wslCredsDescription")}</p>
                <div className="ob-wsl-creds-row">
                  <label className="ob-label">
                    {t("onboarding.wslUsername")}
                    <input
                      className="ob-input"
                      type="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      value={wslUsername}
                      onChange={(e) => setWslUsername(e.target.value)}
                      placeholder={t("onboarding.wslUsernamePlaceholder")}
                      disabled={wslBusy !== null}
                    />
                  </label>
                  <label className="ob-label">
                    {t("onboarding.wslPassword")}
                    <input
                      className="ob-input"
                      type="password"
                      value={wslPassword}
                      onChange={(e) => setWslPassword(e.target.value)}
                      placeholder={t("onboarding.wslPasswordPlaceholder")}
                      disabled={wslBusy !== null}
                    />
                  </label>
                </div>
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
                      {wslBusy === "all" ? t("onboarding.installingWsl") : t("onboarding.installWsl")}
                    </button>
                  )}
                  {allOk && <span className="ob-success">{t("onboarding.allSet")}</span>}
                  <button className="ob-btn ob-btn--ghost" onClick={refreshWsl} disabled={wslBusy !== null}>
                    {t("onboarding.recheck")}
                  </button>
                </div>
              );
            })()}

            {wslLog && (
              <pre className="ob-log">{wslLog}</pre>
            )}
            </>
            )}

            <div className="ob-actions" style={{ marginTop: 24 }}>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(2)}>{t("onboarding.back")}</button>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(4)} disabled={wslBusy !== null}>{t("onboarding.skip")}</button>
              <button className="ob-btn" onClick={() => setStep(4)} disabled={wslBusy !== null}>{t("onboarding.next")}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="ob-body">
            <h3>{t("onboarding.step4Title")}</h3>
            <p className="ob-sub">
              {t("onboarding.step4Description")}
            </p>
            <ul className="ob-bullets">
              <li>{t("onboarding.skillDocx")}</li>
              <li>{t("onboarding.skillXlsx")}</li>
              <li>{t("onboarding.skillPptx")}</li>
              <li>{t("onboarding.skillPdf")}</li>
              <li>{t("onboarding.skillCreate")}</li>
            </ul>
            <p className="ob-sub2">
              {t("onboarding.skillsSource")}
            </p>

            {skillsInstalled !== null && (
              <div className="ob-success">
                {t("onboarding.skillsInstalled", { count: skillsInstalled })}
              </div>
            )}

            <div className="ob-actions" style={{ marginTop: 24 }}>
              <button className="ob-btn ob-btn--ghost" onClick={() => setStep(isWindows ? 3 : 2)}>{t("onboarding.back")}</button>
              {skillsInstalled === null ? (
                <>
                  <button className="ob-btn ob-btn--ghost" onClick={finish} disabled={saving || skillsInstalling}>
                    {t("onboarding.skipSkills")}
                  </button>
                  <button className="ob-btn" onClick={installAnthropicSkills} disabled={skillsInstalling || saving}>
                    {skillsInstalling ? t("onboarding.installingSkills") : t("onboarding.installSkills")}
                  </button>
                </>
              ) : (
                <button className="ob-btn" onClick={finish} disabled={saving}>
                  {saving ? t("onboarding.finishing") : t("onboarding.finish")}
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
