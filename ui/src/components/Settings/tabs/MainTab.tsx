import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check, Camera, SignOut, Warning, Trash,
  X as XIcon, ArrowClockwise, CheckCircle, XCircle, Terminal,
  UserCircle, Globe, Palette, ShieldWarning,
  Sun, Moon, Monitor,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { AvatarCircle } from "../../Sidebar";
import { API_BASE } from "../../../utils/apiBase";
import { SUPPORTED_LANGUAGES } from "../../../i18n/languages";
import type { SettingsData } from "../SettingsPanel";

const FLAG_MAP: Record<string, string> = {
  en: "\u{1F1EC}\u{1F1E7}",
  ru: "\u{1F1F7}\u{1F1FA}",
};

/* ── MainTab ──────────────────── */

export function MainTab({ settings, onUpdate, avatarUrl, setAvatarFromFile, clearAvatar, onSignOut }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
  avatarUrl: string | null;
  setAvatarFromFile: (file: File) => Promise<void>;
  clearAvatar: () => void;
  onSignOut: (deleteChats: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState(settings.user_name ?? "");
  const [showSignOut, setShowSignOut] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(settings.user_name ?? "");
  }, [settings.user_name]);

  const handleBlur = useCallback(() => {
    if (draft !== (settings.user_name ?? "")) {
      onUpdate({ user_name: draft });
    }
  }, [draft, settings.user_name, onUpdate]);

  const handleAvatarFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await setAvatarFromFile(file);
    e.target.value = "";
  }, [setAvatarFromFile]);

  const currentTheme = settings.theme || "system";
  const currentLang = settings.language || i18n.resolvedLanguage || "en";
  const unrestricted = settings.unrestricted_mode ?? false;

  return (
    <div className="st2-main">
      <h3 className="st2-h">{t("settings.general.title")}</h3>
      <p className="st2-sub">
        {t("settings.general.description")}
      </p>

      {/* 01 Профиль */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>{t("settings.general.profile")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.general.profileDescription")}
        </p>
        <div className="st2-mrows">
          {/* Avatar + Name combined */}
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t"><UserCircle size={16} /> {t("settings.general.avatar")}</p>
              <p className="d">{t("settings.general.avatarHint")}</p>
            </div>
            <div className="st2-mctl">
              <div className="id-combo">
                <div className="avatar-circle" onClick={() => avatarInputRef.current?.click()} title={t("settings.general.clickToUpload")}>
                  <AvatarCircle url={avatarUrl} name={draft || settings.user_name} size={48} />
                  <span className="edit-badge">✎</span>
                </div>
                <div className="input-wrap">
                  <input type="text" value={draft} maxLength={32}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={handleBlur}
                    placeholder={t("settings.general.userNamePlaceholder")} />
                  <span className="char-hint">{draft.length} / 32</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="st2-avatar-btn" onClick={() => avatarInputRef.current?.click()}>
                  <Camera size={14} /> {avatarUrl ? t("settings.general.changePhoto") : t("settings.general.uploadPhoto")}
                </button>
                {avatarUrl && (
                  <button className="st2-avatar-btn st2-avatar-btn--del" onClick={clearAvatar}>
                    <XIcon size={12} weight="bold" /> {t("settings.general.deletePhoto")}
                  </button>
                )}
              </div>
              <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarFile} />
            </div>
          </div>

          {/* Sign out row */}
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t"><SignOut size={16} /> {t("settings.general.signOut")}</p>
              <p className="d">{t("settings.general.signOutDescription")}</p>
            </div>
            <div className="st2-mctl">
              <button className="st2-signout-btn" onClick={() => setShowSignOut(true)}>
                <SignOut size={14} weight="bold" />
                {t("settings.general.signOutButton")}
              </button>
            </div>
          </div>
        </div>
      </section>

      {showSignOut && (
        <SignOutDialog
          onClose={() => setShowSignOut(false)}
          onConfirm={(deleteChats) => { setShowSignOut(false); onSignOut(deleteChats); }}
        />
      )}

      {/* 02 Appearance */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>{t("settings.general.appearance")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.general.appearanceDescription")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t"><Globe size={16} /> {t("settings.general.language")}</p>
              <p className="d">{t("settings.general.languageHint")}</p>
            </div>
            <div className="st2-mctl">
              <div className="lang-picker">
                <span className="flag">{FLAG_MAP[currentLang] ?? ""}</span>
                <span className="lang-name">{SUPPORTED_LANGUAGES.find((l) => l.code === currentLang)?.label ?? currentLang}</span>
                <span className="arrow">▾</span>
                <select value={currentLang} onChange={(e) => onUpdate({ language: e.target.value })}>
                  {SUPPORTED_LANGUAGES.map((lng) => (
                    <option key={lng.code} value={lng.code}>{lng.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="st2-mrow stack">
            <div className="st2-mlab">
              <p className="t"><Palette size={16} /> {t("settings.general.theme")}</p>
              <p className="d">{t("settings.general.themeHint")}</p>
            </div>
            <div className="st2-mctl">
              <div className="theme-cards" role="radiogroup" aria-label={t("settings.general.theme")}>
                <button className={"theme-card" + (currentTheme === "light" ? " sel" : "")}
                  onClick={() => onUpdate({ theme: "light" })}>
                  <svg className="tc-preview-svg" viewBox="0 0 120 78" xmlns="http://www.w3.org/2000/svg">
                    <rect width="120" height="78" rx="4" fill="#f6f4ef"/>
                    <rect x="8" y="10" width="44" height="5" rx="2" fill="#1a1a1a" opacity=".85"/>
                    <rect x="8" y="20" width="28" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                    <rect x="8" y="28" width="52" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                    <rect x="8" y="36" width="36" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                    <rect x="60" y="58" width="52" height="12" rx="6" fill="#1a1a1a" opacity=".9"/>
                  </svg>
                  <div className="tc-foot">
                    <span className="name"><Sun size={14} weight="bold" /> {t("settings.general.themeLight")}</span>
                    <span className="check">{currentTheme === "light" ? "✓" : ""}</span>
                  </div>
                </button>
                <button className={"theme-card" + (currentTheme === "dark" ? " sel" : "")}
                  onClick={() => onUpdate({ theme: "dark" })}>
                  <svg className="tc-preview-svg" viewBox="0 0 120 78" xmlns="http://www.w3.org/2000/svg">
                    <rect width="120" height="78" rx="4" fill="#15130e"/>
                    <rect x="8" y="10" width="44" height="5" rx="2" fill="#f0ead8" opacity=".85"/>
                    <rect x="8" y="20" width="28" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                    <rect x="8" y="28" width="52" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                    <rect x="8" y="36" width="36" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                    <rect x="60" y="58" width="52" height="12" rx="6" fill="#3a2f23"/>
                  </svg>
                  <div className="tc-foot">
                    <span className="name"><Moon size={14} weight="bold" /> {t("settings.general.themeDark")}</span>
                    <span className="check">{currentTheme === "dark" ? "✓" : ""}</span>
                  </div>
                </button>
                <button className={"theme-card" + (currentTheme === "system" ? " sel" : "")}
                  onClick={() => onUpdate({ theme: "system" })}>
                  <svg className="tc-preview-svg" viewBox="0 0 120 78" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                      <clipPath id="tc-auto-clip"><rect width="120" height="78" rx="4"/></clipPath>
                    </defs>
                    <g clipPath="url(#tc-auto-clip)">
                      <rect width="60" height="78" fill="#f6f4ef"/>
                      <rect x="60" width="60" height="78" fill="#15130e"/>
                      <rect x="8" y="10" width="36" height="5" rx="2" fill="#1a1a1a" opacity=".85"/>
                      <rect x="8" y="20" width="24" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                      <rect x="8" y="28" width="42" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                      <rect x="28" y="58" width="26" height="12" rx="6" fill="#1a1a1a" opacity=".9"/>
                      <rect x="68" y="10" width="36" height="5" rx="2" fill="#f0ead8" opacity=".85"/>
                      <rect x="68" y="20" width="24" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                      <rect x="68" y="28" width="42" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                      <rect x="88" y="58" width="26" height="12" rx="6" fill="#3a2f23"/>
                      <line x1="60" y1="0" x2="60" y2="78" stroke="#888" strokeWidth=".5" strokeDasharray="2,2"/>
                    </g>
                  </svg>
                  <div className="tc-foot">
                    <span className="name"><Monitor size={14} weight="bold" /> {t("settings.general.themeSystem")}</span>
                    <span className="check">{currentTheme === "system" ? "✓" : ""}</span>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 03 Sandbox */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">03</span>
          <h2>{t("settings.general.sandbox")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.general.sandboxDescription")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow stack">
            <div className="st2-mctl">
              <div className={`st2-danger-row${unrestricted ? " on" : ""}`}>
                <div className="lab">
                  <p className="t"><ShieldWarning size={16} /> {t("settings.general.unrestricted")}</p>
                  <p className="d">
                    {t("settings.general.unrestrictedDescription")}
                  </p>
                </div>
                <div className="st2-danger-switch">
                  <div className={`st2-switch${unrestricted ? " on" : ""}`}
                    onClick={() => onUpdate({ unrestricted_mode: !unrestricted })} />
                </div>
              </div>
              {unrestricted && (
                <div className="st2-risk-note">
                  <b>{t("settings.general.sandboxRemoved")}</b>
                  <ul>
                    <li>{t("settings.general.sandboxReadAnyFile")}</li>
                    <li>{t("settings.general.sandboxNoIsolation")}</li>
                    <li>{t("settings.general.sandboxRestartAgent")}</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 04 Terminal */}
      <ShellSection
        preference={settings.shell_preference ?? "auto"}
        onChange={(v) => onUpdate({ shell_preference: v })}
      />
    </div>
  );
}

/* ── Shell (WSL ⇄ PowerShell) ───────────────────── */

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
  powershell_available: boolean;
  active_shell: "wsl" | "powershell";
  shell_preference: "auto" | "wsl" | "powershell";
}

function ShellSection({
  preference,
  onChange,
}: {
  preference: "auto" | "wsl" | "powershell";
  onChange: (v: "auto" | "wsl" | "powershell") => void;
}) {
  const { t } = useTranslation();
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

  const wslOk = !!status?.wsl_installed && !!status?.distro_running;
  const psOk = !!status?.powershell_available;
  const activeShell = status?.active_shell ?? (preference === "powershell" ? "powershell" : "wsl");

  return (
    <section>
      <div className="st2-mh">
        <span className="st2-mn">04</span>
        <h2>{t("settings.general.terminal")}</h2>
      </div>
      <p className="st2-md">
        {t("settings.general.terminalDescription")}
      </p>

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
                ]}
                active={activeShell === "powershell"}
              />
            </div>
          </div>
        </div>

        {/* Preference picker */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t">{t("settings.general.shellPreference")}</p>
            <p className="d">
              {t("settings.general.shellPreferenceHint")}
            </p>
          </div>
          <div className="st2-mctl">
            <div className="st2-theme">
              <button
                className={preference === "auto" ? "active" : ""}
                onClick={() => onChange("auto")}
              >
                <Terminal /> {t("settings.general.shellAuto")}
              </button>
              <button
                className={preference === "wsl" ? "active" : ""}
                onClick={() => onChange("wsl")}
              >
                <Terminal /> {t("settings.general.shellWsl")}
              </button>
              <button
                className={preference === "powershell" ? "active" : ""}
                onClick={() => onChange("powershell")}
              >
                <Terminal /> {t("settings.general.shellPowershell")}
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
                title={t("settings.general.installWsl")}
              >
                {installing === "distro" ? t("settings.general.installing") : t("settings.general.installWsl")}
              </button>
              <button
                className="st2-btn"
                onClick={installDeps}
                disabled={installing !== null || !status?.distro_running}
                title={t("settings.general.installDeps")}
              >
                {installing === "deps" ? t("settings.general.installing") : t("settings.general.installDeps")}
              </button>
              {status?.distro_running && !status.dns_ok && (
                <button
                  className="st2-btn"
                  onClick={fixDns}
                  disabled={installing !== null}
                  title={t("settings.general.fixDns")}
                >
                  {installing === "dns" ? t("settings.general.fixing") : t("settings.general.fixDns")}
                </button>
              )}
              <button
                className="st2-btn st2-btn--ghost"
                onClick={reload}
                disabled={loading}
              >
                <ArrowClockwise /> {loading ? t("settings.general.checking") : t("settings.general.checkAgain")}
              </button>
              {!wslOk && psOk && preference !== "powershell" && (
                <button
                  className="st2-btn"
                  onClick={() => onChange("powershell")}
                  title={t("settings.general.switchToPowershellHint")}
                >
                  {t("settings.general.switchToPowershell")}
                </button>
              )}
            </div>
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
  const { t } = useTranslation();
  return (
    <div className={`st2-shell-card${active ? " active" : ""}${ok ? " ok" : " bad"}`}>
      <div className="st2-shell-card-h">
        {ok ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
        <span className="st2-shell-card-title">{title}</span>
        {active && <span className="st2-shell-card-active">{t("settings.general.active")}</span>}
      </div>
      {lines.map((ln, i) => (
        <div key={i} className="st2-shell-card-ln">{ln}</div>
      ))}
    </div>
  );
}

/* ── Sign Out Dialog ────────────────────────────────────────────────────── */

function SignOutDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (deleteChats: boolean) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="confirm-overlay" onClick={onClose}>
      <div className="confirm-dialog signout-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="confirm-close" onClick={onClose}><XIcon weight="bold" /></button>

        <div className="signout-header">
          <div className="signout-icon"><Warning size={22} weight="fill" /></div>
          <div>
            <h3 className="confirm-title">{t("settings.signOut.title")}</h3>
            <p className="signout-sub">{t("settings.signOut.subtitle")}</p>
          </div>
        </div>

        <div className="signout-options">
          <button
            className="signout-opt signout-opt--danger"
            onClick={() => onConfirm(true)}
          >
            <div className="signout-opt-icon"><Trash size={16} weight="bold" /></div>
            <div className="signout-opt-text">
              <span className="signout-opt-title">{t("settings.signOut.deleteAll")}</span>
              <span className="signout-opt-desc">{t("settings.signOut.deleteAllHint")}</span>
            </div>
          </button>

          <button
            className="signout-opt"
            onClick={() => onConfirm(false)}
          >
            <div className="signout-opt-icon"><SignOut size={16} weight="bold" /></div>
            <div className="signout-opt-text">
              <span className="signout-opt-title">{t("settings.signOut.keepChats")}</span>
              <span className="signout-opt-desc">{t("settings.signOut.keepChatsHint")}</span>
            </div>
          </button>
        </div>

        <button className="confirm-btn confirm-btn--cancel" style={{ width: "100%", textAlign: "center", marginTop: 4 }} onClick={onClose}>
          {t("settings.signOut.cancel")}
        </button>
      </div>
    </div>
  );
}
