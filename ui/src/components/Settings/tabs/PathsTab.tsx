import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, Globe, Check, Copy, DeviceMobile } from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { API_BASE, setBackendUrl } from "../../../utils/apiBase";
import { useSettings } from "../../../contexts/SettingsContext";
import { RestartBackendButton } from "../RestartBackendButton";

interface RemoteAccessInfo {
  enabled: boolean;
  token: string;
  port: number;
  urls: string[];
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
    <div className="st2-main">
      <h3 className="st2-h">{t("settings.paths.title")}</h3>
      <p className="st2-sub">{t("settings.paths.description")}</p>

      {/* 01 Storage paths */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>{t("settings.paths.storage")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.paths.storageHint")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.paths.skillsFolder")}</p>
              <p className="d">{t("settings.paths.skillsFolderHint")}</p>
            </div>
            <div className="st2-mctl">
              <div className="st2-path"><Folder /> {t("settings.paths.skillsFolderValue")}</div>
            </div>
          </div>

          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.paths.workDir")}</p>
              <p className="d">{t("settings.paths.workDirHint")}</p>
            </div>
            <div className="st2-mctl">
              <div className="st2-path"><Folder /> {t("settings.paths.workDirValue")}</div>
            </div>
          </div>
        </div>
      </section>

      {/* 02 Backend connection */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>{t("settings.paths.connection")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.paths.connectionHint")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.paths.backendUrl")}</p>
              <p className="d">{t("settings.paths.backendUrlHint")}</p>
            </div>
            <div className="st2-mctl">
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
                <button
                  className={`st2-paths-url-btn${applied ? " applied" : ""}`}
                  onClick={handleApply}
                >
                  {applied ? <><Check weight="bold" /> {t("settings.paths.applied")}</> : t("settings.paths.apply")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 03 Remote access (phone) */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">03</span>
          <h2>{t("settings.paths.remoteAccess")}</h2>
        </div>
        <p className="st2-md">{t("settings.paths.remoteAccessHint")}</p>

        {!manageable ? (
          <p className="st2-md">{t("settings.paths.remoteLocalOnly")}</p>
        ) : (
          <div className="st2-mrows">
            <div className="st2-mrow stack">
              <div className="st2-mctl">
                <div className={`st2-danger-row${enabled ? " on" : ""}`}>
                  <div className="lab">
                    <p className="t"><DeviceMobile size={16} /> {t("settings.paths.remoteAllow")}</p>
                    <p className="d">{t("settings.paths.remoteAllowHint")}</p>
                  </div>
                  <div className="st2-danger-switch">
                    <div
                      className={`st2-switch${enabled ? " on" : ""}`}
                      onClick={() => { void handleToggleRemote(); }}
                    />
                  </div>
                </div>
              </div>

              <div className="st2-remote-restart-row">
                <RestartBackendButton
                  className="st2-remote-copy"
                  onDone={() => { setRestartHint(false); void loadInfo(); }}
                />
                {restartHint && (
                  <p className="st2-remote-restart">{t("settings.paths.remoteRestart")}</p>
                )}
              </div>

              {enabled && info && (
                <div className="st2-remote-pair">
                  {pairUrl ? (
                    <>
                      <p className="st2-md">{t("settings.paths.remoteScan")}</p>
                      <div className="st2-remote-qr">
                        <QRCodeSVG value={pairUrl} size={168} level="M" />
                      </div>
                      {info.urls.length > 1 && (
                        <div className="st2-remote-urls">
                          {info.urls.map((u) => (
                            <button
                              key={u}
                              className={`st2-remote-url-chip${u === selectedUrl ? " on" : ""}`}
                              onClick={() => setSelectedUrl(u)}
                            >
                              {u.replace(/^https?:\/\//, "")}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="st2-md">{t("settings.paths.remoteNoUrls")}</p>
                  )}

                  {selectedUrl && (
                    <div className="st2-remote-field">
                      <span className="lab">{t("settings.paths.remoteUrlLabel")}</span>
                      <code>{selectedUrl}</code>
                      <button className="st2-remote-copy" onClick={() => void copy(selectedUrl, "url")}>
                        {copied === "url" ? <Check weight="bold" /> : <Copy />}
                        {copied === "url" ? t("settings.paths.remoteCopied") : t("settings.paths.remoteCopy")}
                      </button>
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

                  <p className="st2-md">{t("settings.paths.remoteTailscaleHint")}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
