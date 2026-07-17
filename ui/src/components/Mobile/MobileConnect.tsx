/** Backend connect/reconnect screen for remote clients (the Android APK ships
 *  WITHOUT a backend; the phone PWA talks to one over a token).
 *
 *  Two modes, picked by the `variant` prop:
 *   - "setup"     — first-run gate, no way out, before anything touches the API.
 *   - "reconnect" — overlay shown over the already-running app when the
 *     configured backend stops answering (expired token, network loss, …);
 *     dismissible, and pre-fills the previously configured address.
 *
 *  Two ways to (re)connect:
 *   - Scan QR  — from a PC running AgentChat with remote access on (QR encodes
 *     the pairing link http://host:port/?token=…); fills everything automatically.
 *   - Manual   — type the URL + token (VDS / VPS / self-hosted).
 *
 *  On success we persist the override and reload — from then on API_BASE targets
 *  the remote backend and the normal app boots against it. */

import { useEffect, useState } from "react";
import { QrCode, Keyboard, ArrowLeft, CircleNotch, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { setBackendUrl, setToken, getBackendOverride } from "../../utils/apiBase";

type Mode = "choose" | "manual";

interface MobileConnectProps {
  /** "setup" (default) is the first-run gate with no way out. "reconnect" is an
   *  overlay shown over the running app when the backend connection drops
   *  (expired token, network loss, …) — it's dismissible and pre-fills the
   *  previously configured address. */
  variant?: "setup" | "reconnect";
  onDismiss?: () => void;
}

export function MobileConnect({ variant = "setup", onDismiss }: MobileConnectProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("choose");
  const [url, setUrl] = useState(variant === "reconnect" ? getBackendOverride() : "");
  const [token, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The native barcode scanner renders the camera BEHIND the webview, so while
  // scanning we strip the page background to transparent and show only a thin
  // overlay (frame + cancel). Restore on exit.
  useEffect(() => {
    if (!scanning) return;
    const els = [
      document.documentElement,
      document.body,
      document.getElementById("root"),
    ].filter(Boolean) as HTMLElement[];
    const prev = els.map((el) => el.style.background);
    els.forEach((el) => { el.style.background = "transparent"; });
    return () => { els.forEach((el, i) => { el.style.background = prev[i] ?? ""; }); };
  }, [scanning]);

  const connect = async (rawUrl: string, rawToken: string) => {
    const base = rawUrl.trim().replace(/\/+$/, "");
    if (!base) { setError(t("mobile.errUrlRequired")); return; }
    setBusy(true);
    setError(null);
    try {
      // /api/wsl/status is behind the remote-access guard: a 200 proves the
      // backend is reachable AND the token is valid + remote access is on.
      const resp = await fetch(`${base}/api/wsl/status`, {
        headers: rawToken.trim() ? { Authorization: `Bearer ${rawToken.trim()}` } : {},
      });
      if (resp.status === 401) { setError(t("mobile.errToken")); setBusy(false); return; }
      if (!resp.ok) { setError(t("mobile.errGeneric")); setBusy(false); return; }
      setToken(rawToken.trim());
      setBackendUrl(base); // persists the override and reloads the page
    } catch {
      setError(t("mobile.errUnreachable"));
      setBusy(false);
    }
  };

  const handleScanned = (content: string) => {
    try {
      const u = new URL(content);
      const tk = u.searchParams.get("token") ?? "";
      const base = `${u.protocol}//${u.host}`;
      if (tk) { void connect(base, tk); return; }
      setUrl(base);
      setMode("manual");
    } catch {
      // Not a URL — drop the raw text into the manual field for editing.
      setUrl(content);
      setMode("manual");
    }
  };

  const startScan = async () => {
    setError(null);
    try {
      const mod = await import("@tauri-apps/plugin-barcode-scanner");
      let perm = await mod.checkPermissions();
      if (perm !== "granted") perm = await mod.requestPermissions();
      if (perm !== "granted") { setError(t("mobile.scanPermDenied")); return; }
      setScanning(true);
      const res = await mod.scan({ windowed: false, formats: [mod.Format.QRCode] });
      setScanning(false);
      if (res?.content) handleScanned(res.content);
    } catch {
      setScanning(false);
      setError(t("mobile.scanFailed"));
    }
  };

  const cancelScan = async () => {
    try {
      const mod = await import("@tauri-apps/plugin-barcode-scanner");
      await mod.cancel();
    } catch { /* no-op */ }
    setScanning(false);
  };

  if (scanning) {
    return (
      <div className="mc-scan">
        <div className="mc-scan-frame" />
        <p className="mc-scan-hint">{t("mobile.scanning")}</p>
        <button className="ob-btn ob-btn--ghost mc-scan-cancel" onClick={() => void cancelScan()}>
          {t("mobile.scanCancel")}
        </button>
      </div>
    );
  }

  const isReconnect = variant === "reconnect";

  return (
    <div className="ob-overlay">
      <div className="ob-card">
        <div className="ob-header">
          <h2>{isReconnect ? t("mobile.reconnectTitle") : t("mobile.connectTitle")}</h2>
          {onDismiss && (
            <button className="confirm-close" onClick={onDismiss} aria-label={t("common.close")} title={t("common.close")}>
              <X weight="bold" />
            </button>
          )}
        </div>
        <div className="ob-body">
          {busy ? (
            <div className="mc-connecting">
              <CircleNotch size={32} weight="bold" className="ob-spin" />
              <p className="mc-connecting-title">{t("mobile.connecting")}</p>
              <p className="mc-connecting-hint">{t("mobile.connectingHint")}</p>
            </div>
          ) : (
            <>
              <p className="ob-sub">{isReconnect ? t("mobile.reconnectSubtitle") : t("mobile.connectSubtitle")}</p>
              {error && <div className="ob-error">{error}</div>}

              {mode === "choose" && (
                <div className="mc-choices">
                  <button className="mc-choice" onClick={() => void startScan()}>
                    <QrCode size={28} weight="duotone" />
                    <span className="mc-choice-title">{t("mobile.scanOption")}</span>
                    <span className="mc-choice-sub">{t("mobile.scanOptionHint")}</span>
                  </button>
                  <button className="mc-choice" onClick={() => { setError(null); setMode("manual"); }}>
                    <Keyboard size={28} weight="duotone" />
                    <span className="mc-choice-title">{t("mobile.manualOption")}</span>
                    <span className="mc-choice-sub">{t("mobile.manualOptionHint")}</span>
                  </button>
                </div>
              )}

              {mode === "manual" && (
                <>
                  <label className="ob-label">{t("mobile.backendUrlLabel")}</label>
                  <input
                    className="ob-input"
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    value={url}
                    onChange={(e) => { setError(null); setUrl(e.target.value); }}
                    placeholder={t("mobile.backendUrlPlaceholder")}
                  />

                  <label className="ob-label" style={{ marginTop: 12 }}>{t("mobile.tokenLabel")}</label>
                  <input
                    className="ob-input"
                    type="password"
                    value={token}
                    onChange={(e) => { setError(null); setTokenInput(e.target.value); }}
                    placeholder={t("mobile.tokenPlaceholder")}
                    onKeyDown={(e) => { if (e.key === "Enter") void connect(url, token); }}
                  />

                  <div className="ob-actions" style={{ marginTop: 20 }}>
                    <button className="ob-btn ob-btn--ghost" onClick={() => { setError(null); setMode("choose"); }}>
                      <ArrowLeft size={16} /> {t("mobile.back")}
                    </button>
                    <button className="ob-btn" onClick={() => void connect(url, token)}>
                      {t("mobile.connectButton")}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
