/** Onboarding wizard — first-run setup: name → provider/model → environment → skills.
 *
 * Side-rail layout: a clickable step rail on the left, the active step on the
 * right. Step 3 (shell + dependencies) lives in {@link EnvironmentStep}. */

import { useEffect, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";
import { useTranslation } from "react-i18next";
import { EnvironmentStep } from "./EnvironmentStep";

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

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 1 | 2 | 3 | 4;

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(1);
  const [maxStep, setMaxStep] = useState<Step>(1);
  const [userName, setUserName] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [envBusy, setEnvBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Host OS — decides which face the environment step wears: the WSL/PowerShell
  // setup on Windows, the bash⇄zsh picker plus a read-only checklist elsewhere.
  const [osPlatform, setOsPlatform] = useState<string>("windows");

  const go = (n: Step) => {
    setStep(n);
    setMaxStep((m) => (n > m ? n : m));
  };

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
    // WSL/environment setup step at all.
    fetch(`${API_BASE}/system-status`)
      .then((r) => r.json())
      .then((d) => { if (typeof d.os_platform === "string") setOsPlatform(d.os_platform); })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshModels = async () => {
    try {
      const r = await fetch(`${API_BASE}/models?refresh=true`);
      if (r.ok) {
        const d = await r.json();
        setModels(d.models ?? []);
      }
    } catch {
      /* no-op */
    }
  };

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
      go(2);
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
      go(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("onboarding.modelSaveError"));
    } finally {
      setSaving(false);
    }
  };

  const finish = async (): Promise<boolean> => {
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
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("onboarding.completeError"));
      setSaving(false);
      return false;
    }
  };

  // Finish onboarding, then jump straight to the Skills page in Settings, where
  // skills are installed from the bundled repo catalog (not the old GitHub pull).
  const finishAndOpenSkills = async () => {
    if (await finish()) {
      window.dispatchEvent(new CustomEvent("navigate", { detail: "skills" }));
    }
  };

  const selectedProviderObj = providers.find((p) => p.id === selectedProvider);
  const providerModels = models.filter((m) => m.id.startsWith(selectedProvider + "/"));

  const rail: { n: Step; label: string }[] = [
    { n: 1, label: t("onboarding.navName") },
    { n: 2, label: t("onboarding.navProvider") },
    { n: 3, label: t("onboarding.navEnvironment") },
    { n: 4, label: t("onboarding.navSkills") },
  ];

  return (
    <div className="ob-overlay">
      <div className="ob-card">
        <div className="ob-header">
          <h2>{t("onboarding.welcome")}</h2>
        </div>

        <div className="ob-shell-layout">
          <nav className="ob-rail">
            {rail.map(({ n, label }) => {
              const state = step === n ? "active" : maxStep >= n ? "done" : "todo";
              const reachable = maxStep >= n && !envBusy;
              return (
                <button
                  key={n}
                  type="button"
                  className={`ob-rail-step ${state}`}
                  onClick={() => reachable && go(n)}
                  disabled={!reachable}
                >
                  <span className="ob-rail-badge">
                    {maxStep > n && step !== n ? <Check size={13} weight="bold" /> : n}
                  </span>
                  <span className="ob-rail-label">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="ob-content">
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
                  <button className="ob-btn ob-btn--ghost" onClick={() => go(2)}>{t("onboarding.skip")}</button>
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
                  <button className="ob-btn ob-btn--ghost" onClick={() => go(1)}>{t("onboarding.back")}</button>
                  <button className="ob-btn ob-btn--ghost" onClick={() => go(3)}>{t("onboarding.skip")}</button>
                  <button className="ob-btn" onClick={handleNextFromProvider} disabled={saving}>
                    {saving ? "…" : t("onboarding.next")}
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <>
                <EnvironmentStep osPlatform={osPlatform} onBusyChange={setEnvBusy} onError={setError} />
                <div className="ob-actions">
                  <button className="ob-btn ob-btn--ghost" onClick={() => go(2)} disabled={envBusy}>{t("onboarding.back")}</button>
                  <button className="ob-btn ob-btn--ghost" onClick={() => go(4)} disabled={envBusy}>{t("onboarding.skip")}</button>
                  <button className="ob-btn" onClick={() => go(4)} disabled={envBusy}>{t("onboarding.next")}</button>
                </div>
              </>
            )}

            {step === 4 && (
              <div className="ob-body">
                <h3>{t("onboarding.step4Title")}</h3>
                <p className="ob-sub">{t("onboarding.step4Description")}</p>
                <ul className="ob-bullets">
                  <li>{t("onboarding.skillDocx")}</li>
                  <li>{t("onboarding.skillXlsx")}</li>
                  <li>{t("onboarding.skillPptx")}</li>
                  <li>{t("onboarding.skillPdf")}</li>
                  <li>{t("onboarding.skillCreate")}</li>
                </ul>
                <p className="ob-sub2">{t("onboarding.skillsSource")}</p>

                <div className="ob-actions">
                  <button className="ob-btn ob-btn--ghost" onClick={() => go(3)}>{t("onboarding.back")}</button>
                  <button className="ob-btn ob-btn--ghost" onClick={finish} disabled={saving}>
                    {saving ? t("onboarding.finishing") : t("onboarding.skipSkills")}
                  </button>
                  <button className="ob-btn" onClick={finishAndOpenSkills} disabled={saving}>
                    {t("onboarding.openSkills")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
