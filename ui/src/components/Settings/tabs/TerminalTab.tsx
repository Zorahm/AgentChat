/** Settings → Terminal: WSL ⇄ PowerShell shell selection + dependency install. */

import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, XCircle, Terminal } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { API_BASE } from "../../../utils/apiBase";
import { isAndroidTauri } from "../../../utils/tauri";
import { playNotificationSound } from "../../../utils/notify";
import type { SettingsData } from "../SettingsPanel";

interface ShellStatus {
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
  powershell_available: boolean;
  zsh_available: boolean;
  active_shell: "wsl" | "powershell" | "posix" | "zsh";
  shell_preference: "auto" | "wsl" | "powershell" | "zsh";
  os_platform: "windows" | "linux" | "darwin";
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

export function TerminalTab({ settings, onUpdate }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
}) {
  const { t } = useTranslation();
  const preference = settings.shell_preference ?? "auto";
  const onChange = (v: "auto" | "wsl" | "powershell" | "zsh") => onUpdate({ shell_preference: v });

  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [winStatus, setWinStatus] = useState<WinDepsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<null | "distro" | "deps" | "dns" | "network" | "windeps">(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [wslR, winR] = await Promise.all([
        fetch(`${API_BASE}/wsl/status`),
        fetch(`${API_BASE}/win/status`),
      ]);
      if (wslR.ok) setStatus(await wslR.json());
      if (winR.ok) setWinStatus(await winR.json());
    } catch { /* no-op */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const installDistro = async () => {
    setInstalling("distro");
    setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/install-distro`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? t("settings.general.installStarted") : t("settings.general.installErrorGeneric")));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settings.general.networkError"));
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const installDeps = async () => {
    setInstalling("deps");
    setMessage(t("settings.general.installing"));
    try {
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        setMessage(data.output ?? t("settings.general.installError"));
        setInstalling(null);
        return;
      }
      setMessage(data.output ?? t("settings.general.installStarted"));

      // Poll the background task every 3s until it stops running.
      let lastLog = "";
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const s = await fetch(`${API_BASE}/wsl/install-deps/status`);
          if (!s.ok) continue;
          const payload = await s.json() as { running: boolean; log: string; error: string | null };
          if (payload.log && payload.log !== lastLog) {
            lastLog = payload.log;
            setMessage(payload.log);
          }
          if (!payload.running) {
            if (payload.error) setMessage(`${payload.log}\n\n${t("settings.general.installErrorGeneric")}: ${payload.error}`);
            playNotificationSound();
            break;
          }
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settings.general.networkError"));
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
      setMessage(data.output ?? (r.ok ? t("settings.general.dnsFixed") : t("settings.general.installErrorGeneric")));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settings.general.networkError"));
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const fixNetwork = async () => {
    setInstalling("network");
    setMessage(t("settings.general.fixingNetwork"));
    try {
      const r = await fetch(`${API_BASE}/wsl/fix-network`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? t("settings.general.networkFixed") : t("settings.general.installErrorGeneric")));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settings.general.networkError"));
    } finally {
      setInstalling(null);
      reload();
    }
  };

  // PowerShell-native deps install — same flow as WSL installDeps, but the
  // backend installs via winget instead of apt. Polls the background task.
  const installWinDeps = async () => {
    setInstalling("windeps");
    setMessage(t("settings.general.installing"));
    try {
      const r = await fetch(`${API_BASE}/win/install-deps`, { method: "POST" });
      const data = await r.json();
      if (!r.ok || !data.success) {
        setMessage(data.output ?? t("settings.general.installError"));
        setInstalling(null);
        return;
      }
      setMessage(data.output ?? t("settings.general.installStarted"));

      let lastLog = "";
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const s = await fetch(`${API_BASE}/win/install-deps/status`);
          if (!s.ok) continue;
          const payload = await s.json() as { running: boolean; log: string; error: string | null };
          if (payload.log && payload.log !== lastLog) {
            lastLog = payload.log;
            setMessage(payload.log);
          }
          if (!payload.running) {
            if (payload.error) setMessage(`${payload.log}\n\n${t("settings.general.installErrorGeneric")}: ${payload.error}`);
            playNotificationSound();
            break;
          }
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settings.general.networkError"));
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const wslOk = !!status?.wsl_installed && !!status?.distro_running;
  const psOk = !!status?.powershell_available;
  const depsAllOk = wslOk && !!status?.node && !!status?.python && !!status?.npm
    && !!status?.pandoc && !!status?.libreoffice && !!status?.poppler && !!status?.docx;
  const winDepsAllOk = !!winStatus?.is_windows && !!winStatus.node && !!winStatus.python
    && !!winStatus.pandoc && !!winStatus.libreoffice && winStatus.poppler && winStatus.docx;
  // Resolve the active shell locally from the chosen preference + availability,
  // mirroring the backend's resolve_active_shell. This makes the highlighted
  // card flip instantly on tab switch instead of waiting for the next fetch.
  // Before the first probe lands (status null) assume WSL for "auto" so the
  // common case doesn't flash PowerShell as active on mount.
  const wslPresent = status?.wsl_installed ?? true;
  const activeShell: "wsl" | "powershell" =
    preference === "powershell"
      ? "powershell"
      : preference === "wsl"
        ? "wsl"
        : wslPresent
          ? "wsl"
          : "powershell";

  // Native Linux/macOS host: no WSL/PowerShell split. Show a bash⇄zsh picker
  // (zsh only when explicitly chosen) and hide the Windows install actions.
  if (status && status.os_platform !== "windows") {
    const zshActive = preference === "zsh";
    const depsLine = [
      status.node ? "node ✓" : "node ✗",
      status.python ? "python3 ✓" : "python3 ✗",
      status.npm ? "npm ✓" : "npm ✗",
      status.pandoc ? "pandoc ✓" : "pandoc ✗",
      status.libreoffice ? "libreoffice ✓" : "libreoffice ✗",
      status.poppler ? "poppler ✓" : "poppler ✗",
    ].join(" · ");
    return (
      <div className="st2-main">
        <div className="st2-h-row">
          <h3 className="st2-h">{t("settings.general.terminal")}</h3>
          <Button
            label={loading ? t("settings.general.checking") : t("settings.general.checkAgain")}
            icon={<ArrowClockwise />}
            onClick={reload}
            isDisabled={loading}
            isLoading={loading}
            variant="secondary"
          />
        </div>
        <p className="st2-sub">{t("settings.general.terminalNativeDescription")}</p>
        <div className="st2-mrows">
          <div className="st2-mrow stack">
            <div className="st2-mctl">
              <div className="st2-shell-grid">
                <ShellStatusCard
                  title={t("settings.general.nativeBash")}
                  ok={true}
                  lines={[t("settings.general.nativeBashActive"), depsLine]}
                  active={!zshActive}
                />
                <ShellStatusCard
                  title={t("settings.general.nativeZsh")}
                  ok={status.zsh_available}
                  lines={[
                    status.zsh_available
                      ? t("settings.general.nativeZshActive")
                      : t("settings.general.nativeZshNotFound"),
                    depsLine,
                  ]}
                  active={zshActive}
                />
              </div>
            </div>
          </div>

          {/* bash ⇄ zsh picker — hidden in the mobile APK (the phone doesn't
              choose the remote backend's shell). */}
          {!isAndroidTauri() && (
            <div className="st2-mrow">
              <div className="st2-mlab">
                <p className="t">{t("settings.general.shellPreference")}</p>
                <p className="d">{t("settings.general.shellPreferenceNativeHint")}</p>
              </div>
              <div className="st2-mctl">
                <div className="st2-shell-actions">
                  <Button
                    label={t("settings.general.shellBash")}
                    icon={<Terminal />}
                    onClick={() => onChange("auto")}
                    variant={!zshActive ? "primary" : "secondary"}
                  />
                  <Button
                    label={t("settings.general.shellZsh")}
                    icon={<Terminal />}
                    onClick={() => onChange("zsh")}
                    variant={zshActive ? "primary" : "secondary"}
                  />
                </div>
                {zshActive && !status.zsh_available && (
                  <div className="st2-risk-note" style={{ marginTop: 10 }}>
                    <b>{t("settings.general.zshMissingWarning")}</b>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="st2-main">
      <div className="st2-h-row">
        <h3 className="st2-h">{t("settings.general.terminal")}</h3>
        <Button
          label={loading ? t("settings.general.checking") : t("settings.general.checkAgain")}
          icon={<ArrowClockwise />}
          onClick={reload}
          isDisabled={loading}
          isLoading={loading}
          variant="secondary"
        />
      </div>
      <p className="st2-sub">{t("settings.general.terminalDescription")}</p>

      <div className="st2-mrows">
        {/* Status grid */}
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            <div className="st2-shell-grid">
              <ShellStatusCard
                title={t("settings.general.wslBash")}
                ok={wslOk}
                lines={[
                  status
                    ? status.wsl_installed
                      ? t("settings.general.wslFound", { distro: status.default_distro ?? undefined })
                      : t("settings.general.wslNotFound")
                    : "—",
                  status?.wsl_installed
                    ? status.distro_running
                      ? t("settings.general.wslLaunching")
                      : t("settings.general.wslNotAvailable")
                    : "",
                  status?.distro_running
                    ? [
                        status.node ? "node ✓" : "node ✗",
                        status.python ? "python3 ✓" : "python3 ✗",
                        status.npm ? "npm ✓" : "npm ✗",
                        status.pandoc ? "pandoc ✓" : "pandoc ✗",
                        status.libreoffice ? "libreoffice ✓" : "libreoffice ✗",
                        status.poppler ? "poppler ✓" : "poppler ✗",
                        status.dns_ok ? "DNS ✓" : "DNS ✗",
                        status.internet_ok ? "internet ✓" : "internet ✗",
                      ].join(" · ")
                    : "",
                ].filter(Boolean)}
                active={activeShell === "wsl"}
              />
              <ShellStatusCard
                title={t("settings.general.powershell")}
                ok={psOk}
                lines={[
                  status
                    ? status.powershell_available
                      ? t("settings.general.powershellFound")
                      : t("settings.general.powershellNotFound")
                    : "—",
                  t("settings.general.softSandbox"),
                  winStatus?.is_windows
                    ? [
                        winStatus.node ? "node ✓" : "node ✗",
                        winStatus.python ? "python ✓" : "python ✗",
                        winStatus.pandoc ? "pandoc ✓" : "pandoc ✗",
                        winStatus.libreoffice ? "libreoffice ✓" : "libreoffice ✗",
                        winStatus.poppler ? "poppler ✓" : "poppler ✗",
                        winStatus.docx ? "docx ✓" : "docx ✗",
                      ].join(" · ")
                    : "",
                ].filter(Boolean)}
                active={activeShell === "powershell"}
              />
            </div>
          </div>
        </div>

        {/* Preference picker — hidden in the mobile APK: the shell is whatever
            the remote backend runs, the phone doesn't choose it. */}
        {!isAndroidTauri() && (
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.general.shellPreference")}</p>
              <p className="d">
                {t("settings.general.shellPreferenceHint")}
              </p>
            </div>
            <div className="st2-mctl">
              <div className="st2-shell-actions">
                <Button
                  label={t("settings.general.shellAuto")}
                  icon={<Terminal />}
                  onClick={() => onChange("auto")}
                  variant={preference === "auto" ? "primary" : "secondary"}
                />
                <Button
                  label={t("settings.general.shellWsl")}
                  icon={<Terminal />}
                  onClick={() => onChange("wsl")}
                  variant={preference === "wsl" ? "primary" : "secondary"}
                />
                <Button
                  label={t("settings.general.shellPowershell")}
                  icon={<Terminal />}
                  onClick={() => onChange("powershell")}
                  variant={preference === "powershell" ? "primary" : "secondary"}
                />
              </div>
            </div>
          </div>
        )}

        {/* Action buttons — WSL-specific; hidden when PowerShell is forced */}
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            {preference !== "powershell" && (
              <div className="st2-shell-actions">
                {!wslOk ? (
                  <Button
                    label={installing === "distro" ? t("settings.general.installing") : t("settings.general.installWsl")}
                    onClick={installDistro}
                    isDisabled={installing !== null}
                    isLoading={installing === "distro"}
                    variant="secondary"
                  />
                ) : !depsAllOk ? (
                  <Button
                    label={installing === "deps" ? t("settings.general.installing") : t("settings.general.installDeps")}
                    onClick={installDeps}
                    isDisabled={installing !== null}
                    isLoading={installing === "deps"}
                    variant="secondary"
                  />
                ) : (
                  <span className="st2-shell-allok">{t("settings.general.allInstalled")}</span>
                )}
                {wslOk && !status?.dns_ok && (
                  <Button
                    label={installing === "dns" ? t("settings.general.fixing") : t("settings.general.fixDns")}
                    onClick={fixDns}
                    isDisabled={installing !== null}
                    isLoading={installing === "dns"}
                    variant="secondary"
                  />
                )}
                {wslOk && !status?.internet_ok && (
                  <Button
                    label={installing === "network" ? t("settings.general.fixing") : t("settings.general.fixNetwork")}
                    onClick={fixNetwork}
                    isDisabled={installing !== null}
                    isLoading={installing === "network"}
                    variant="secondary"
                  />
                )}
              </div>
            )}
            {activeShell === "powershell" && winStatus?.is_windows && (
              <div className="st2-shell-actions">
                {winDepsAllOk ? (
                  <span className="st2-shell-allok">{t("settings.general.allInstalled")}</span>
                ) : winStatus.winget ? (
                  <Button
                    label={installing === "windeps" ? t("settings.general.installing") : t("settings.general.installDeps")}
                    onClick={installWinDeps}
                    isDisabled={installing !== null}
                    isLoading={installing === "windeps"}
                    variant="secondary"
                  />
                ) : (
                  <span className="st2-shell-note">{t("settings.general.wingetMissing")}</span>
                )}
              </div>
            )}
            {message && (
              <pre className="st2-shell-msg">{message}</pre>
            )}
            {activeShell === "powershell" && (
              <div className="st2-risk-note" style={{ marginTop: 10 }}>
                <b>{t("settings.general.powershellWarning")}</b>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
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
  const { t } = useTranslation();
  return (
    <Card className={`st2-shell-card${active ? " active" : ""}${ok ? " ok" : " bad"}`} padding={0}>
      <div className="st2-shell-card-h">
        {ok ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
        <span className="st2-shell-card-title">{title}</span>
        {active && <span className="st2-shell-card-active">{t("settings.general.active")}</span>}
      </div>
      {lines.map((ln, i) => (
        <div key={i} className="st2-shell-card-ln">{ln}</div>
      ))}
    </Card>
  );
}
