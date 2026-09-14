/** Environment setup — automated first-run environment configuration.
 *
 * Replaces the manual multi-step wizard. Sets the user's name to "AgentChat",
 * probes system platform and dependencies (WSL or Windows winget),
 * installs missing tools automatically while displaying a spinner,
 * and seamlessly marks onboarding complete.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretUp, Check, WarningCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { API_BASE } from "../../utils/apiBase";

export interface EnvironmentSetupProps {
  onComplete: () => void;
}

type SetupStage =
  | "idle"
  | "profile"
  | "checking"
  | "installing"
  | "finalizing"
  | "done"
  | "error";

interface PollState {
  running: boolean;
  log: string;
  error: string | null;
}

interface WSLStatusResponse {
  wsl_installed: boolean;
  distro_running: boolean;
  node: string | null;
  python: string | null;
  pandoc: string | null;
  libreoffice: string | null;
  poppler: boolean;
  docx: boolean;
}

interface WinDepsStatusResponse {
  is_windows: boolean;
  winget: boolean;
  node: string | null;
  python: string | null;
  pandoc: string | null;
  libreoffice: string | null;
  poppler: boolean;
  docx: boolean;
}

async function pollInstall(url: string, onLog: (log: string) => void): Promise<void> {
  let lastLog = "";
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const s = await fetch(url);
      if (!s.ok) continue;
      const p = (await s.json()) as PollState;
      if (p.log && p.log !== lastLog) {
        lastLog = p.log;
        onLog(p.log);
      }
      if (!p.running) {
        if (p.error) throw new Error(p.error);
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.message) throw err;
    }
  }
}

export function EnvironmentSetup({ onComplete }: EnvironmentSetupProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<SetupStage>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [log, setLog] = useState<string>("");
  const [showLog, setShowLog] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSetup = useCallback(async () => {
    setErrorMessage(null);
    setLog("");
    setStage("profile");
    setStatusMessage(t("onboarding.setupProfile"));
    setStatusDetail("");

    try {
      // Step 1: Set user_name to "AgentChat"
      const settingsRes = await fetch(`${API_BASE}/settings`);
      let currentUserName = "";
      if (settingsRes.ok) {
        const data = (await settingsRes.json()) as { user_name?: string };
        currentUserName = typeof data.user_name === "string" ? data.user_name.trim() : "";
      }

      const effectiveName = currentUserName || "AgentChat";
      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_name: effectiveName }),
      });

      if (!mountedRef.current) return;

      // Step 2: Probe environment
      setStage("checking");
      setStatusMessage(t("onboarding.setupChecking"));

      const sysRes = await fetch(`${API_BASE}/system-status`).catch(() => null);
      const sysData = sysRes && sysRes.ok ? ((await sysRes.json()) as { os_platform?: string }) : null;
      const osPlatform = sysData?.os_platform || "windows";

      if (osPlatform === "windows") {
        const [wslRes, winRes] = await Promise.allSettled([
          fetch(`${API_BASE}/wsl/status`).then((r) => (r.ok ? r.json() : null)),
          fetch(`${API_BASE}/win/status`).then((r) => (r.ok ? r.json() : null)),
        ]);

        const wslData = wslRes.status === "fulfilled" ? (wslRes.value as WSLStatusResponse | null) : null;
        const winData = winRes.status === "fulfilled" ? (winRes.value as WinDepsStatusResponse | null) : null;

        if (wslData?.wsl_installed && wslData?.distro_running) {
          // WSL is available and active
          await fetch(`${API_BASE}/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shell_preference: "wsl" }),
          });

          const missingWsl =
            !wslData.node ||
            !wslData.python ||
            !wslData.pandoc ||
            !wslData.libreoffice ||
            !wslData.poppler ||
            !wslData.docx;

          if (missingWsl) {
            if (!mountedRef.current) return;
            setStage("installing");
            setStatusMessage(t("onboarding.setupInstallingWsl"));
            setStatusDetail("apt: node, python, pandoc, libreoffice, poppler, docx");

            const installRes = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
            const installJson = (await installRes.json()) as { success?: boolean; output?: string };
            if (installJson.output) {
              setLog(installJson.output);
            }
            if (!installRes.ok || installJson.success === false) {
              throw new Error(installJson.output || t("onboarding.wslInstallError"));
            }

            await pollInstall(`${API_BASE}/wsl/install-deps/status`, (text) => {
              if (mountedRef.current) setLog(text);
            });
          }
        } else {
          // Fall back to native PowerShell
          await fetch(`${API_BASE}/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shell_preference: "powershell" }),
          });

          if (winData?.winget) {
            const missingWin =
              !winData.node ||
              !winData.python ||
              !winData.pandoc ||
              !winData.libreoffice ||
              !winData.poppler ||
              !winData.docx;

            if (missingWin) {
              if (!mountedRef.current) return;
              setStage("installing");
              setStatusMessage(t("onboarding.setupInstallingWin"));
              setStatusDetail("winget: node, python, pandoc, libreoffice, poppler, docx");

              const installRes = await fetch(`${API_BASE}/win/install-deps`, { method: "POST" });
              const installJson = (await installRes.json()) as { success?: boolean; output?: string };
              if (installJson.output) {
                setLog(installJson.output);
              }
              if (!installRes.ok || installJson.success === false) {
                throw new Error(installJson.output || t("onboarding.wslInstallError"));
              }

              await pollInstall(`${API_BASE}/win/install-deps/status`, (text) => {
                if (mountedRef.current) setLog(text);
              });
            }
          }
        }
      } else {
        // Native Linux/macOS
        await fetch(`${API_BASE}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shell_preference: "auto" }),
        });
      }

      if (!mountedRef.current) return;

      // Step 3: Finalize
      setStage("finalizing");
      setStatusMessage(t("onboarding.setupFinalizing"));
      setStatusDetail("");

      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboarding_completed: true, user_name: effectiveName }),
      });

      if (!mountedRef.current) return;

      setStage("done");
      setStatusMessage(t("onboarding.setupDone"));

      setTimeout(() => {
        if (mountedRef.current) {
          onComplete();
        }
      }, 750);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : t("onboarding.setupError");
      setErrorMessage(msg);
      setStage("error");
      setStatusMessage(t("onboarding.setupError"));
      setStatusDetail("");
    }
  }, [t, onComplete]);

  useEffect(() => {
    void runSetup();
  }, [runSetup]);

  const handleSkip = async () => {
    try {
      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboarding_completed: true, user_name: "AgentChat" }),
      });
    } catch {
      // Continue anyway
    }
    onComplete();
  };

  const isError = stage === "error";
  const isDone = stage === "done";

  return (
    <div className="ob-overlay">
      <div className="ob-card ob-card--setup" role="dialog" aria-modal="true">
        <div className="ob-setup-header">
          <img className="ob-setup-mark" src="/dots.svg" alt="" />
          <h2 className="ob-setup-title">{t("onboarding.setupTitle")}</h2>
          <p className="ob-setup-sub">{t("onboarding.setupSubtitle")}</p>
        </div>

        <div className="ob-setup-body">
          <div
            className={`ob-setup-spinner-wrap${
              isDone ? " ob-setup-spinner-wrap--success" : isError ? " ob-setup-spinner-wrap--error" : ""
            }`}
          >
            {isDone ? (
              <Check size={32} weight="bold" />
            ) : isError ? (
              <WarningCircle size={32} weight="duotone" />
            ) : (
              <Spinner size="lg" />
            )}
          </div>

          <div className="ob-setup-status-box">
            <span className="ob-setup-status-text">{statusMessage}</span>
            {statusDetail && <span className="ob-setup-status-detail">{statusDetail}</span>}
          </div>

          {log && (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
              <button
                type="button"
                className="ob-setup-log-toggle"
                onClick={() => setShowLog((v) => !v)}
              >
                {showLog ? <CaretUp size={14} /> : <CaretDown size={14} />}
                {t("onboarding.setupLog")}
              </button>
              {showLog && <div className="ob-setup-log">{log}</div>}
            </div>
          )}

          {isError && errorMessage && (
            <div className="ob-setup-error-box">
              {errorMessage}
            </div>
          )}

          {isError && (
            <div className="ob-setup-actions">
              <Button
                variant="ghost"
                label={t("onboarding.setupContinueAnyway")}
                onClick={handleSkip}
              />
              <Button
                variant="primary"
                label={t("onboarding.setupRetry")}
                onClick={() => void runSetup()}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
