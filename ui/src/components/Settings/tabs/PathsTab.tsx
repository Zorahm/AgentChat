import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Check, Copy, DeviceMobile } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { Switch } from "@astryxdesign/core/Switch";
import { Button } from "@astryxdesign/core/Button";
import { API_BASE, setBackendUrl } from "../../../utils/apiBase";
import { useSettings } from "../../../contexts/SettingsContext";
import { RestartBackendButton } from "../RestartBackendButton";
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
  const [backendUrl, setBackendUrlState] = useState(
    localStorage.getItem("agentchat.backendUrl") ?? ""
  );
  const [applied, setApplied] = useState(false);

  // Remote-access pairing state. `manageable` is false when this very client is
  // the remote one (the pairing endpoint is loopback-only and returns 403).
  const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
  const [manageable, setManageable] = useState(true);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [restartHint, setRestartHint] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  const handleApply = useCallback(() => {
    setBackendUrl(backendUrl);
    setApplied(true);
    setTimeout(() => setApplied(false), 1500);
  }, [backendUrl]);

  const loadInfo = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/remote-access`);
      if (res.status === 403) {
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

  const handleToggleRemote = useCallback(async () => {
    const next = !(info?.enabled ?? false);
    await updateSettings({ remote_access_enabled: next });
    setRestartHint(true);
    await loadInfo();
  }, [info, updateSettings, loadInfo]);

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

      {/* Remote access — let a phone connect to this backend */}
      {!manageable ? (
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

      {/* Backend connection — point this client at a backend elsewhere */}
      <div className="st2-remote-conn">
        <div className="st2-remote-conn-head">
          <Globe size={16} />
          <div className="st2-remote-conn-titles">
            <div className="st2-remote-conn-title">{t("settings.paths.connection")}</div>
            <div className="st2-remote-conn-sub">{t("settings.paths.connectionHint")}</div>
          </div>
        </div>
        <div className="st2-paths-url-row">
          <div className="st2-paths-url-input">
            <Globe size={14} />
            <input
              type="text"
              value={backendUrl}
              onChange={(e) => { setBackendUrlState(e.target.value); setApplied(false); }}
              placeholder={t("settings.paths.backendUrlPlaceholder")}
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            />
          </div>
          <Button
            label={applied ? t("settings.paths.applied") : t("settings.paths.apply")}
            icon={applied ? <Check weight="bold" /> : undefined}
            onClick={handleApply}
            variant="primary"
          />
        </div>
      </div>

      {/* Backend restart — desktop shell only */}
      {isTauri() && (
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
