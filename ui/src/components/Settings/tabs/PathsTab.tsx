import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, DeviceMobile, ArrowsClockwise, CloudArrowUp } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { Switch } from "@astryxdesign/core/Switch";
import { Button } from "@astryxdesign/core/Button";
import { API_BASE } from "../../../utils/apiBase";
import { useSettings } from "../../../contexts/SettingsContext";
import { RestartBackendButton } from "../RestartBackendButton";
import { ServerModeCard } from "./paths/ServerModeCard";
import { isTauri } from "../../../utils/tauri";

interface RemoteAccessInfo {
  enabled: boolean;
  token: string;
  port: number;
  urls: string[];
}

/** True for a Tailscale address (100.64.0.0/10) — the one a paired phone on the
 * same tailnet can actually reach. Backend lists it first; we tag it here. */
function isTailscaleUrl(url: string): boolean {
  const m = url.match(/^https?:\/\/(\d+)\.(\d+)\./);
  const first = m?.[1];
  const second = m?.[2];
  if (!first || !second) return false;
  return first === "100" && Number(second) >= 64 && Number(second) <= 127;
}

export function PathsTab() {
  const { t } = useTranslation();
  const { updateSettings } = useSettings();

  // Remote-access pairing state. `manageable` is false when this very client is
  // the remote one (the pairing endpoint is loopback-only and returns 403), or
  // when the backend runs in server mode and never serves it at all (404).
  const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
  const [manageable, setManageable] = useState(true);
  // Set when the *backend* runs as a server: pairing and restart are things a
  // local sidecar offers, and neither would work against a remote host.
  const [backendIsServer, setBackendIsServer] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [restartHint, setRestartHint] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);
  // Rotation drops every paired device, so the first click only arms the
  // button and the second one actually rolls the token.
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/remote-access`);
      if (res.status === 403 || res.status === 404) {
        setManageable(false);
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as RemoteAccessInfo;
      setManageable(true);
      setInfo(data);
      setSelectedUrl((prev) => prev || data.urls[0] || "");
    } catch {
      /* backend unreachable — leave section hidden */
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/system-status`);
        if (!res.ok) return;
        const data = (await res.json()) as { server_mode?: boolean };
        setBackendIsServer(Boolean(data.server_mode));
      } catch {
        /* backend unreachable — assume a local one and show everything */
      }
    })();
  }, []);

  const handleToggleRemote = useCallback(async () => {
    const next = !(info?.enabled ?? false);
    await updateSettings({ remote_access_enabled: next });
    setRestartHint(true);
    await loadInfo();
  }, [info, updateSettings, loadInfo]);

  const handleRotate = useCallback(async () => {
    if (!confirmRotate) {
      setConfirmRotate(true);
      setTimeout(() => setConfirmRotate(false), 4000);
      return;
    }
    setConfirmRotate(false);
    setRotating(true);
    try {
      const res = await fetch(`${API_BASE}/remote-access/rotate`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as RemoteAccessInfo;
        setInfo(data);
      }
    } catch {
      /* backend unreachable — the old token stays valid */
    } finally {
      setRotating(false);
    }
  }, [confirmRotate]);

  const copy = useCallback(async (value: string, which: "url" | "token") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const enabled = info?.enabled ?? false;
  const pairUrl =
    info && selectedUrl ? `${selectedUrl}/?token=${encodeURIComponent(info.token)}` : "";

  return (
    <div className="st2-remote">
      <h3 className="st2-h">{t("settings.paths.title")}</h3>
      <p className="st2-sub">{t("settings.paths.description")}</p>

      {/* Remote access — let a phone connect to this backend. A server-mode
          backend hands its token out through the installer instead, so there is
          nothing to pair here. */}
      {backendIsServer ? (
        <div className="st2-remote-locked">
          <CloudArrowUp size={18} />
          <span>{t("settings.paths.remoteServerManaged")}</span>
        </div>
      ) : !manageable ? (
        <div className="st2-remote-locked">
          <DeviceMobile size={18} />
          <span>{t("settings.paths.remoteLocalOnly")}</span>
        </div>
      ) : (
        <div className={`st2-remote-card${enabled ? " on" : ""}`}>
          <div className="st2-remote-head">
            <div className="st2-remote-head-icon"><DeviceMobile size={20} weight="duotone" /></div>
            <div className="st2-remote-head-text">
              <div className="st2-remote-head-title">{t("settings.paths.remoteAllow")}</div>
              <div className="st2-remote-head-sub">{t("settings.paths.remoteAllowHint")}</div>
            </div>
            <Switch
              label={t("settings.paths.remoteAllow")}
              isLabelHidden
              value={enabled}
              onChange={() => { void handleToggleRemote(); }}
            />
          </div>

          {(enabled || restartHint) && (
            <div className="st2-remote-body">
              <div className="st2-remote-restart-row">
                <RestartBackendButton
                  onDone={() => { setRestartHint(false); void loadInfo(); }}
                />
                {restartHint && (
                  <p className="st2-remote-restart">{t("settings.paths.remoteRestart")}</p>
                )}
              </div>

              {enabled && info && (
                pairUrl ? (
                  <div className="st2-remote-pair">
                    <div className="st2-remote-pair-grid">
                      <div className="st2-remote-qr">
                        <QRCodeSVG value={pairUrl} size={156} level="M" />
                      </div>
                      <div className="st2-remote-pair-info">
                        <p className="st2-remote-scan">{t("settings.paths.remoteScan")}</p>

                        {info.urls.length > 1 && (
                          <div className="st2-remote-urls">
                            {info.urls.map((u) => (
                              <Button
                                key={u}
                                label={`${u.replace(/^https?:\/\//, "")}${isTailscaleUrl(u) ? " · Tailscale" : ""}`}
                                onClick={() => setSelectedUrl(u)}
                                variant={u === selectedUrl ? "primary" : "secondary"}
                                size="sm"
                              />
                            ))}
                          </div>
                        )}

                        {selectedUrl && (
                          <div className="st2-remote-field">
                            <span className="lab">{t("settings.paths.remoteUrlLabel")}</span>
                            <code>{selectedUrl}</code>
                            <Button
                              label={copied === "url" ? t("settings.paths.remoteCopied") : t("settings.paths.remoteCopy")}
                              icon={copied === "url" ? <Check weight="bold" /> : <Copy />}
                              onClick={() => void copy(selectedUrl, "url")}
                              variant="secondary"
                              size="sm"
                            />
                          </div>
                        )}

                        <div className="st2-remote-field">
                          <span className="lab">{t("settings.paths.remoteToken")}</span>
                          <code className="token">{info.token}</code>
                          <button className="st2-remote-copy" onClick={() => void copy(info.token, "token")}>
                            {copied === "token" ? <Check weight="bold" /> : <Copy />}
                            {copied === "token" ? t("settings.paths.remoteCopied") : t("settings.paths.remoteCopy")}
                          </button>
                        </div>

                        <div className="st2-remote-rotate">
                          <Button
                            label={
                              rotating
                                ? t("settings.paths.remoteRotating")
                                : confirmRotate
                                  ? t("settings.paths.remoteRotateConfirm")
                                  : t("settings.paths.remoteRotate")
                            }
                            icon={<ArrowsClockwise weight="bold" />}
                            onClick={() => void handleRotate()}
                            isDisabled={rotating}
                            variant={confirmRotate ? "primary" : "secondary"}
                            size="sm"
                          />
                          <span className="hint">{t("settings.paths.remoteRotateHint")}</span>
                        </div>
                      </div>
                    </div>

                    <p className="st2-remote-tailscale">{t("settings.paths.remoteTailscaleHint")}</p>
                  </div>
                ) : (
                  <p className="st2-remote-empty">{t("settings.paths.remoteNoUrls")}</p>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* Server mode — point this client at a backend elsewhere */}
      <ServerModeCard />

      {/* Backend restart — desktop shell only, and only for its own sidecar */}
      {isTauri() && !backendIsServer && (
        <div className="st2-remote-conn">
          <div className="st2-remote-conn-head">
            <div className="st2-remote-conn-titles">
              <div className="st2-remote-conn-title">{t("settings.backend.restart")}</div>
              <div className="st2-remote-conn-sub">{t("settings.backend.restartHint")}</div>
            </div>
          </div>
          <div className="st2-paths-restart-row">
            <RestartBackendButton />
          </div>
        </div>
      )}
    </div>
  );
}
