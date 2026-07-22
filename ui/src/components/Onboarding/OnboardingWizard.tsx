/** Onboarding wizard — first-run setup: name → provider/model → environment → skills.
 *
 * Side-rail layout: a clickable step rail on the left, the active step on the
 * right. Step 3 (shell + dependencies) lives in {@link EnvironmentStep}. */

import { useEffect, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";
import { useTranslation } from "react-i18next";
import { EnvironmentStep } from "./EnvironmentStep";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";

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
                <Button
                  key={n}
                  type="button"
                  variant={step === n ? "primary" : "secondary"}
                  label={label}
                  onClick={() => reachable && go(n)}
                  isDisabled={!reachable}
                  size="sm"
                  icon={maxStep > n && step !== n ? <Check size={13} weight="bold" /> : undefined}
                  className="ob-rail-step"
                />
              );
            })}
          </nav>

          <div className="ob-content">
            {error && <div className="ob-error">{error}</div>}

            {step === 1 && (
              <div className="ob-body">
                <h3>{t("onboarding.step1Title")}</h3>
                <p className="ob-sub">{t("onboarding.step1Description")}</p>
                <TextInput
                  hasAutoFocus
                  label={t("onboarding.step1Placeholder")}
                  value={userName}
                  onChange={(value: string) => setUserName(value)}
                  placeholder={t("onboarding.step1Placeholder")}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && handleNextFromName()}
                  isLabelHidden
                />
                <div className="ob-actions">
                  <Button variant="ghost" label={t("onboarding.skip")} onClick={() => go(2)} />
                  <Button variant="primary" label={saving ? t("onboarding.saving") : t("onboarding.next")} onClick={handleNextFromName} isDisabled={saving} isLoading={saving} />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="ob-body">
                <h3>{t("onboarding.step2Title")}</h3>
                <p className="ob-sub">{t("onboarding.step2Description")}</p>

                <Selector
                  label={t("onboarding.step2Provider")}
                  value={selectedProvider}
                  onChange={(v: string) => { setSelectedProvider(v); setDefaultModel(""); }}
                  options={providers.map((p) => ({ value: p.id, label: `${p.name}${p.api_key_set ? " ✓" : ""}` }))}
                />

                <TextInput
                  type="password"
                  label={`${t("onboarding.step2ApiKey")} ${selectedProviderObj?.api_key_set ? `(${t("onboarding.step2ApiKeyHint")})` : ""}`}
                  value={apiKey}
                  onChange={(value: string) => setApiKey(value)}
                  placeholder={selectedProviderObj?.api_key_set ? t("onboarding.step2ApiKeyNewPlaceholder") : t("onboarding.step2ApiKeyPlaceholder")}
                  style={{ marginTop: 12 }}
                />
                <Button variant="secondary" label={t("onboarding.step2SaveKey")} onClick={handleSaveKey} isDisabled={saving || !apiKey.trim()} size="sm" />

                <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
                  <label className="ob-label">{t("onboarding.step2DefaultModel")}</label>
                  <Button variant="ghost" label={t("onboarding.step2Refresh")} onClick={refreshModels} size="sm" />
                </div>
                <Selector
                  label={t("onboarding.step2DefaultModel")}
                  value={defaultModel}
                  onChange={(v: string) => setDefaultModel(v)}
                  options={[{ value: "", label: t("onboarding.step2SelectModel") }, ...providerModels.map((m) => ({ value: m.id, label: m.name ?? m.id }))]}
                  isLabelHidden
                />
                {providerModels.length === 0 && (
                  <p className="ob-sub2">{t("onboarding.step2NoModels")}</p>
                )}

                <div className="ob-actions">
                  <Button variant="ghost" label={t("onboarding.back")} onClick={() => go(1)} />
                  <Button variant="ghost" label={t("onboarding.skip")} onClick={() => go(3)} />
                  <Button variant="primary" label={saving ? "…" : t("onboarding.next")} onClick={handleNextFromProvider} isDisabled={saving} isLoading={saving} />
                </div>
              </div>
            )}

            {step === 3 && (
              <>
                <EnvironmentStep osPlatform={osPlatform} onBusyChange={setEnvBusy} onError={setError} />
                <div className="ob-actions">
                  <Button variant="ghost" label={t("onboarding.back")} onClick={() => go(2)} isDisabled={envBusy} />
                  <Button variant="ghost" label={t("onboarding.skip")} onClick={() => go(4)} isDisabled={envBusy} />
                  <Button variant="primary" label={t("onboarding.next")} onClick={() => go(4)} isDisabled={envBusy} />
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
                  <Button variant="ghost" label={t("onboarding.back")} onClick={() => go(3)} />
                  <Button variant="ghost" label={saving ? t("onboarding.finishing") : t("onboarding.skipSkills")} onClick={finish} isDisabled={saving} isLoading={saving} />
                  <Button variant="primary" label={t("onboarding.openSkills")} onClick={finishAndOpenSkills} isDisabled={saving} isLoading={saving} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
