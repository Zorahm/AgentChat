/** Onboarding step 3 — pick the shell and install its dependencies.
 *
 * Every shell renders the same {@link DependencyCard}; this component owns the
 * status probes and the install/poll flows (apt for WSL, winget for PowerShell)
 * and reports its busy state up so the wizard can lock navigation during a run.
 *
 * On a native Linux/macOS host there is no WSL/PowerShell split: the choice is
 * bash⇄zsh and the checklist is read-only, since the package manager varies by
 * distro and installing needs a root password we must not ask for. The backend
 * names the missing packages instead ({@link WSLStatus.install_command}). */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@astryxdesign/core/Card";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { API_BASE } from "../../utils/apiBase";
import { DependencyCard, type DepItem } from "./DependencyCard";

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
  internet_ok: boolean;
  mirrored_supported: boolean;
  mirrored_active: boolean;
  zsh_available: boolean;
  shell_preference: "auto" | "wsl" | "powershell" | "zsh";
  distro_name: string | null;
  package_manager: string | null;
  install_command: string | null;
}

interface WinDepsStatus {
  is_windows: boolean;
  winget: boolean;
  node: string | null;
  python: string | null;
  pandoc: string | null;
  libreoffice: string | null;
  poppler: boolean;
  docx: boolean;
}

type ShellChoice = "wsl" | "powershell";
type NativeShell = "bash" | "zsh";
type Busy = null | "all" | "network" | "win";

interface EnvironmentStepProps {
  /** Host OS from /api/system-status — "windows" picks the WSL/PowerShell flow. */
  osPlatform: string;
  onBusyChange: (busy: boolean) => void;
  onError: (msg: string | null) => void;
}

interface PollState {
  running: boolean;
  log: string;
  error: string | null;
}

/** Poll a background-install status endpoint until it stops running. */
async function pollInstall(url: string, onLog: (log: string) => void): Promise<void> {
  let lastLog = "";
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
      /* transient network error — keep polling */
    }
  }
}

export function EnvironmentStep({ osPlatform, onBusyChange, onError }: EnvironmentStepProps) {
  const { t } = useTranslation();
  const isWindows = osPlatform === "windows";
  const [shell, setShell] = useState<ShellChoice | null>(null);
  const [wsl, setWsl] = useState<WSLStatus | null>(null);
  const [win, setWin] = useState<WinDepsStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [rechecking, setRechecking] = useState(false);
  const [log, setLog] = useState("");
  const [wslUsername, setWslUsername] = useState("");
  const [wslPassword, setWslPassword] = useState("");
  const recommended = useRef(false);

  useEffect(() => onBusyChange(busy !== null), [busy, onBusyChange]);

  const refreshWsl = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/wsl/status`);
      if (r.ok) setWsl((await r.json()) as WSLStatus);
    } catch {
      setWsl(null);
    }
  }, []);

  const refreshWin = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/win/status`);
      if (r.ok) setWin((await r.json()) as WinDepsStatus);
    } catch {
      setWin(null);
    }
  }, []);

  // Probe both shells once on mount, then pre-select the recommended one so the
  // dependency card is visible without an extra click. WSL when it's present,
  // otherwise PowerShell. The persisted preference only changes on a real click.
  // A native host has no PowerShell to probe — /wsl/status alone describes it.
  useEffect(() => {
    void (async () => {
      if (!isWindows) {
        await refreshWsl();
        return;
      }
      const [w, p] = await Promise.allSettled([
        fetch(`${API_BASE}/wsl/status`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_BASE}/win/status`).then((r) => (r.ok ? r.json() : null)),
      ]);
      const wslData = w.status === "fulfilled" ? (w.value as WSLStatus | null) : null;
      const winData = p.status === "fulfilled" ? (p.value as WinDepsStatus | null) : null;
      setWsl(wslData);
      setWin(winData);
      if (!recommended.current) {
        recommended.current = true;
        setShell(wslData?.wsl_installed ? "wsl" : "powershell");
      }
    })();
  }, [isWindows, refreshWsl]);

  const chooseShell = useCallback(
    async (choice: ShellChoice) => {
      setShell(choice);
      onError(null);
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
      else refreshWin();
    },
    [onError, refreshWsl, refreshWin],
  );

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      if (!isWindows || shell === "wsl") await refreshWsl();
      else await refreshWin();
    } finally {
      setRechecking(false);
    }
  }, [isWindows, shell, refreshWsl, refreshWin]);

  // Native hosts: bash is the default, zsh is opt-in. The choice is derived from
  // the persisted preference rather than mirrored into local state, so a recheck
  // can never disagree with what the backend will actually spawn.
  const nativeShell: NativeShell = wsl?.shell_preference === "zsh" ? "zsh" : "bash";

  const chooseNativeShell = useCallback(
    async (choice: NativeShell) => {
      onError(null);
      try {
        await fetch(`${API_BASE}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shell_preference: choice === "zsh" ? "zsh" : "auto" }),
        });
      } catch {
        /* non-critical — the selection still drives the UI */
      }
      await refreshWsl();
    },
    [onError, refreshWsl],
  );

  const appendLog = (line: string) => setLog((prev) => (prev ? prev + "\n" + line : line));

  // ── WSL: install distro (+ creds) then libraries, one click ──
  const installAll = useCallback(async () => {
    const distroReady = !!wsl && wsl.wsl_installed && wsl.distro_running;
    if (!distroReady && (!wslUsername.trim() || !wslPassword)) {
      onError(t("onboarding.wslCredsRequired"));
      return;
    }
    setBusy("all");
    setLog("");
    onError(null);
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
        await pollInstall(`${API_BASE}/wsl/install-distro/status`, setLog);
        await refreshWsl();
      }

      appendLog(t("onboarding.wslInstallingDeps"));
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.output ?? t("onboarding.wslInstallError"));
      await pollInstall(`${API_BASE}/wsl/install-deps/status`, setLog);
      appendLog(t("onboarding.wslDone"));
    } catch (e) {
      onError(e instanceof Error ? e.message : t("onboarding.networkError"));
    } finally {
      setBusy(null);
      await refreshWsl();
    }
  }, [wsl, wslUsername, wslPassword, onError, t, refreshWsl]);

  const fixNetwork = useCallback(async () => {
    setBusy("network");
    setLog("");
    onError(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/fix-network`, { method: "POST" });
      const data = await r.json();
      setLog(data.output ?? "");
    } catch (e) {
      onError(e instanceof Error ? e.message : t("onboarding.networkError"));
    } finally {
      setBusy(null);
      await refreshWsl();
    }
  }, [onError, t, refreshWsl]);

  // ── PowerShell: one elevated winget batch for everything missing ──
  const installWin = useCallback(async () => {
    setBusy("win");
    setLog("");
    onError(null);
    try {
      const r = await fetch(`${API_BASE}/win/install-deps`, { method: "POST" });
      const d = await r.json();
      if (d.output) setLog(d.output);
      if (!r.ok || !d.success) throw new Error(d.output ?? t("onboarding.wslInstallError"));
      await pollInstall(`${API_BASE}/win/install-deps/status`, setLog);
    } catch (e) {
      onError(e instanceof Error ? e.message : t("onboarding.networkError"));
    } finally {
      setBusy(null);
      await refreshWin();
    }
  }, [onError, t, refreshWin]);

  // ── Build the dependency checklist for each shell ──
  const wslItems = (s: WSLStatus): DepItem[] => [
    {
      key: "distro",
      label: t("onboarding.wslDistro"),
      ok: s.wsl_installed && s.distro_running,
      value: s.distro_running
        ? s.default_distro ?? t("onboarding.wslRunning")
        : s.wsl_installed
          ? t("onboarding.wslNotRunning")
          : t("onboarding.wslNotInstalled"),
    },
    { key: "node", label: t("onboarding.wslNode"), ok: !!s.node, value: s.node ?? "—" },
    { key: "python", label: t("onboarding.wslPython"), ok: !!s.python, value: s.python ?? "—" },
    { key: "pandoc", label: t("onboarding.wslPandoc"), ok: !!s.pandoc, value: s.pandoc ?? "—" },
    { key: "libre", label: t("onboarding.wslLibreOffice"), ok: !!s.libreoffice, value: s.libreoffice ?? "—" },
    { key: "poppler", label: t("onboarding.wslPoppler"), ok: s.poppler, value: s.poppler ? "✓" : "—" },
    { key: "docx", label: t("onboarding.wslDocx"), ok: s.docx, value: s.docx ? "✓" : "—" },
    {
      key: "internet",
      label: t("onboarding.wslInternet"),
      ok: s.internet_ok,
      value: s.internet_ok ? t("onboarding.wslInternetWorking") : t("onboarding.wslInternetBroken"),
    },
  ];

  const nativeItems = (s: WSLStatus): DepItem[] => [
    { key: "node", label: t("onboarding.wslNode"), ok: !!s.node, value: s.node ?? "—" },
    { key: "python", label: t("onboarding.wslPython"), ok: !!s.python, value: s.python ?? "—" },
    { key: "pandoc", label: t("onboarding.wslPandoc"), ok: !!s.pandoc, value: s.pandoc ?? "—" },
    { key: "libre", label: t("onboarding.wslLibreOffice"), ok: !!s.libreoffice, value: s.libreoffice ?? "—" },
    { key: "poppler", label: t("onboarding.wslPoppler"), ok: s.poppler, value: s.poppler ? "✓" : "—" },
    { key: "docx", label: t("onboarding.wslDocx"), ok: s.docx, value: s.docx ? "✓" : "—" },
  ];

  const winItems = (s: WinDepsStatus): DepItem[] => [
    { key: "node", label: t("onboarding.wslNode"), ok: !!s.node, value: s.node ?? "—" },
    { key: "python", label: t("onboarding.wslPython"), ok: !!s.python, value: s.python ?? "—" },
    { key: "pandoc", label: t("onboarding.wslPandoc"), ok: !!s.pandoc, value: s.pandoc ?? "—" },
    { key: "libre", label: t("onboarding.wslLibreOffice"), ok: !!s.libreoffice, value: s.libreoffice ?? "—" },
    { key: "poppler", label: t("onboarding.wslPoppler"), ok: s.poppler, value: s.poppler ? "✓" : "—" },
    { key: "docx", label: t("onboarding.wslDocx"), ok: s.docx, value: s.docx ? "✓" : "—" },
  ];

  if (!isWindows) {
    return (
      <div className="ob-body">
        <h3>{t("onboarding.step3Title")}</h3>
        <p className="ob-sub">
          {t("onboarding.step3DescriptionNative", { distro: wsl?.distro_name ?? t("onboarding.nativeThisSystem") })}
        </p>

        <div className="ob-shell-choice">
          <Card
            className={`ob-shell-card${nativeShell === "bash" ? " selected" : ""}`}
            variant={nativeShell === "bash" ? "blue" : "default"}
            role="button"
            onClick={() => chooseNativeShell("bash")}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                chooseNativeShell("bash");
              }
            }}
          >
            <span className="ob-shell-name">{t("onboarding.shellBash")}</span>
            <span className="ob-shell-desc">{t("onboarding.shellBashDesc")}</span>
          </Card>
          <Card
            className={`ob-shell-card${nativeShell === "zsh" ? " selected" : ""}`}
            variant={nativeShell === "zsh" ? "blue" : "default"}
            role="button"
            onClick={() => chooseNativeShell("zsh")}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                chooseNativeShell("zsh");
              }
            }}
          >
            <span className="ob-shell-name">{t("onboarding.shellZsh")}</span>
            <span className="ob-shell-desc">{t("onboarding.shellZshDesc")}</span>
          </Card>
        </div>

        {wsl === null ? (
          <p className="ob-sub2">{t("onboarding.checkingWsl")}</p>
        ) : (
          <>
            {nativeShell === "zsh" && !wsl.zsh_available && (
              <p className="ob-warn">{t("onboarding.zshMissing")}</p>
            )}
            <DependencyCard
              title={t("onboarding.depsTitle")}
              items={nativeItems(wsl)}
              allOk={!!wsl.node && !!wsl.python && !!wsl.pandoc && !!wsl.libreoffice && wsl.poppler && wsl.docx}
              rechecking={rechecking}
              onRecheck={recheck}
              beforeActions={
                wsl.install_command ? (
                  <div className="ob-native-install">
                    <p className="ob-sub2">
                      {t("onboarding.nativeInstallHint", { manager: wsl.package_manager ?? "" })}
                    </p>
                    <pre className="ob-native-cmd">{wsl.install_command}</pre>
                  </div>
                ) : null
              }
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="ob-body">
      <h3>{t("onboarding.step3Title")}</h3>
      <p className="ob-sub">{t("onboarding.step3Description")}</p>

      <div className="ob-shell-choice">
        <Card
          className={`ob-shell-card${shell === "powershell" ? " selected" : ""}`}
          variant={shell === "powershell" ? "blue" : "default"}
          role="button"
          onClick={() => chooseShell("powershell")}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              chooseShell("powershell");
            }
          }}
        >
          <span className="ob-shell-name">{t("onboarding.shellPowershell")}</span>
          <span className="ob-shell-desc">{t("onboarding.shellPowershellDesc")}</span>
        </Card>
        <Card
          className={`ob-shell-card${shell === "wsl" ? " selected" : ""}`}
          variant={shell === "wsl" ? "blue" : "default"}
          role="button"
          onClick={() => chooseShell("wsl")}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              chooseShell("wsl");
            }
          }}
        >
          <span className="ob-shell-name">{t("onboarding.shellWsl")}</span>
          <span className="ob-shell-desc">{t("onboarding.shellWslDesc")}</span>
        </Card>
      </div>

      {shell === "wsl" &&
        (wsl === null ? (
          <p className="ob-sub2">{t("onboarding.checkingWsl")}</p>
        ) : (
          (() => {
            const allOk =
              wsl.wsl_installed && wsl.distro_running && !!wsl.node && !!wsl.python && !!wsl.npm &&
              !!wsl.pandoc && !!wsl.libreoffice && wsl.poppler && wsl.docx;
            const needsCreds = !wsl.distro_running;
            const installDisabled =
              busy !== null || (needsCreds && (!wslUsername.trim() || !wslPassword));
            return (
              <DependencyCard
                title={t("onboarding.depsTitle")}
                items={wslItems(wsl)}
                allOk={allOk}
                rechecking={rechecking}
                onRecheck={recheck}
                installing={busy === "all"}
                showInstall={!allOk}
                installLabel={busy === "all" ? t("onboarding.installingWsl") : t("onboarding.installEverything")}
                installDisabled={installDisabled}
                onInstall={installAll}
                log={log}
                beforeActions={
                  needsCreds ? (
                    <div className="ob-wsl-creds">
                      <p className="ob-sub2">{t("onboarding.wslCredsDescription")}</p>
                      <div className="ob-wsl-creds-row">
                        <TextInput
                          label={t("onboarding.wslUsername")}
                          type="text"
                          value={wslUsername}
                          onChange={(v) => setWslUsername(v)}
                          placeholder={t("onboarding.wslUsernamePlaceholder")}
                          isDisabled={busy !== null}
                          className="ob-input"
                        />
                        <TextInput
                          label={t("onboarding.wslPassword")}
                          type="password"
                          value={wslPassword}
                          onChange={(v) => setWslPassword(v)}
                          placeholder={t("onboarding.wslPasswordPlaceholder")}
                          isDisabled={busy !== null}
                          className="ob-input"
                        />
                      </div>
                    </div>
                  ) : null
                }
                secondaryActions={
                  wsl.distro_running && !wsl.internet_ok ? (
                    <Button
                      label={busy === "network" ? t("onboarding.fixingNetwork") : t("onboarding.fixNetwork")}
                      variant="ghost"
                      onClick={fixNetwork}
                      isDisabled={busy !== null}
                      isLoading={busy === "network"}
                      className="ob-btn ob-btn--ghost"
                    />
                  ) : null
                }
              />
            );
          })()
        ))}

      {shell === "powershell" &&
        (win === null ? (
          <p className="ob-sub2">{t("onboarding.winChecking")}</p>
        ) : !win.is_windows ? (
          <p className="ob-sub2">{t("onboarding.shellPowershellNote")}</p>
        ) : (
          (() => {
            const allOk =
              !!win.node && !!win.python && !!win.pandoc && !!win.libreoffice && win.poppler && win.docx;
            return (
              <DependencyCard
                title={t("onboarding.depsTitle")}
                items={winItems(win)}
                allOk={allOk}
                rechecking={rechecking}
                onRecheck={recheck}
                installing={busy === "win"}
                showInstall={!allOk && win.winget}
                installLabel={busy === "win" ? t("onboarding.installingWsl") : t("onboarding.installEverything")}
                installDisabled={busy !== null}
                onInstall={installWin}
                note={allOk ? null : win.winget ? t("onboarding.winRestartHint") : t("onboarding.winNoWinget")}
                log={log}
              />
            );
          })()
        ))}
    </div>
  );
}
