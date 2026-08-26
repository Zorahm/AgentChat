/** Onboarding wizard — first-run setup: name → providers → environment → skills.
 *
 * Side-rail layout: numbered steps on the left, the active step on the right.
 * Step 2 ({@link ProviderStep}) is the Settings providers editor in full, and
 * step 3 (shell + dependencies) lives in {@link EnvironmentStep}. */

import { useEffect, useState } from "react";
import {
  Check, FileDoc, FilePdf, FilePpt, FileXls, MagicWand,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { API_BASE } from "../../utils/apiBase";
import { EnvironmentStep } from "./EnvironmentStep";
import { ProviderStep } from "./ProviderStep";

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 1 | 2 | 3 | 4;

const TOTAL_STEPS = 4;

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(1);
  const [maxStep, setMaxStep] = useState<Step>(1);
  const [userName, setUserName] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
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

  useEffect(() => {
    fetch(`${API_BASE}/settings`)
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.user_name === "string") setUserName(d.user_name);
      })
      .catch(() => setError(t("onboarding.connectionError")));
    // Cheap platform probe (no WSL spawning) so we know which face step 3 wears.
    fetch(`${API_BASE}/system-status`)
      .then((r) => r.json())
      .then((d) => { if (typeof d.os_platform === "string") setOsPlatform(d.os_platform); })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Step 2: providers ──
  // The model is already persisted the moment it is picked (ProviderStep writes
  // straight through), so this only guards the step from being left half done.
  const handleNextFromProvider = () => {
    if (!defaultModel) {
      setError(t("onboarding.validationModel"));
      return;
    }
    setError(null);
    go(3);
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

  const rail: { n: Step; label: string; caption: string }[] = [
    { n: 1, label: t("onboarding.navName"), caption: t("onboarding.navNameCaption") },
    { n: 2, label: t("onboarding.navProvider"), caption: t("onboarding.navProviderCaption") },
    { n: 3, label: t("onboarding.navEnvironment"), caption: t("onboarding.navEnvironmentCaption") },
    { n: 4, label: t("onboarding.navSkills"), caption: t("onboarding.navSkillsCaption") },
  ];

  const skills: { icon: React.ReactNode; text: string }[] = [
    { icon: <FileDoc size={18} weight="duotone" />, text: t("onboarding.skillDocx") },
    { icon: <FileXls size={18} weight="duotone" />, text: t("onboarding.skillXlsx") },
    { icon: <FilePpt size={18} weight="duotone" />, text: t("onboarding.skillPptx") },
    { icon: <FilePdf size={18} weight="duotone" />, text: t("onboarding.skillPdf") },
    { icon: <MagicWand size={18} weight="duotone" />, text: t("onboarding.skillCreate") },
  ];

  return (
    <div className="ob-overlay">
      {/* Step 2 carries the whole providers editor, so it gets the wider card. */}
      <div className={`ob-card${step === 2 ? " ob-card--wide" : ""}`}>
        <div className="ob-header">
          <div className="ob-header-text">
            <h2><img className="ob-mark" src="/dots.svg" alt="" />{t("onboarding.welcome")}</h2>
            <p className="ob-header-sub">{t("onboarding.subtitle")}</p>
          </div>
          <span className="ob-step-count">
            {t("onboarding.stepOf", { current: step, total: TOTAL_STEPS })}
          </span>
        </div>

        <div className="ob-progress" aria-hidden>
          <span style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
        </div>

        <div className="ob-shell-layout">
          <nav className="ob-rail">
            {rail.map(({ n, label, caption }) => {
              const reachable = maxStep >= n && !envBusy;
              const done = maxStep > n && step !== n;
              return (
                <button
                  key={n}
                  type="button"
                  className={`ob-rail-item${step === n ? " is-active" : ""}${done ? " is-done" : ""}`}
                  onClick={() => reachable && go(n)}
                  disabled={!reachable}
                >
                  <span className="ob-rail-num">
                    {done ? <Check size={13} weight="bold" /> : n}
                  </span>
                  <span className="ob-rail-text">
                    <span className="ob-rail-label">{label}</span>
                    <span className="ob-rail-cap">{caption}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="ob-content">
            {error && <div className="ob-error">{error}</div>}

            {step === 1 && (
              <div className="ob-body">
                <div className="ob-step-head">
                  <div className="ob-step-head-text">
                    <h3>{t("onboarding.step1Title")}</h3>
                    <p className="ob-sub">{t("onboarding.step1Description")}</p>
                  </div>
                </div>
                <div className="ob-name-field">
                  <TextInput
                    hasAutoFocus
                    label={t("onboarding.step1Placeholder")}
                    value={userName}
                    onChange={(value: string) => setUserName(value)}
                    placeholder={t("onboarding.step1Placeholder")}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && handleNextFromName()}
                    isLabelHidden
                  />
                  <p className="ob-sub2">{t("onboarding.step1Hint")}</p>
                </div>
                <div className="ob-actions">
                  <Button variant="ghost" label={t("onboarding.skip")} onClick={() => go(2)} />
                  <Button variant="primary" label={saving ? t("onboarding.saving") : t("onboarding.next")} onClick={handleNextFromName} isDisabled={saving} isLoading={saving} />
                </div>
              </div>
            )}

            {step === 2 && (
              <>
                <ProviderStep onDefaultModelChange={setDefaultModel} />
                <div className="ob-actions">
                  <Button variant="ghost" label={t("onboarding.back")} onClick={() => go(1)} />
                  <Button variant="ghost" label={t("onboarding.skip")} onClick={() => go(3)} />
                  <Button variant="primary" label={t("onboarding.next")} onClick={handleNextFromProvider} isDisabled={!defaultModel} />
                </div>
              </>
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
                <div className="ob-step-head">
                  <div className="ob-step-head-text">
                    <h3>{t("onboarding.step4Title")}</h3>
                    <p className="ob-sub">{t("onboarding.step4Description")}</p>
                  </div>
                </div>
                <div className="ob-skill-grid">
                  {skills.map((s) => (
                    <div key={s.text} className="ob-skill-tile">
                      <span className="ob-skill-ic">{s.icon}</span>
                      <span className="ob-skill-text">{s.text}</span>
                    </div>
                  ))}
                </div>
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
