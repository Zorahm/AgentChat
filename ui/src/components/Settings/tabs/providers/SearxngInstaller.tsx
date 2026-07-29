/** One-click self-hosted SearXNG: install Docker, install the container, repair its config. */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { API_BASE } from "../../../../utils/apiBase";

interface SearxngStatusDTO {
  wsl_available: boolean;
  docker_available: boolean;
  docker_cli: boolean;
  docker_desktop_installed: boolean;
  winget_available: boolean;
  docker_download_url: string;
  running: boolean;
  url: string | null;
  installing: boolean;
  installing_docker: boolean;
}

const WS = "settings.providers.webSearch";

export function SearxngInstaller({ onInstalled }: { onInstalled: (url: string) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SearxngStatusDTO | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dockerLog, setDockerLog] = useState("");
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [dockerBusy, setDockerBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairResult, setRepairResult] = useState<{ ok: boolean; message: string } | null>(null);
  const notifiedRef = useRef(false);

  const refreshStatus = () => {
    fetch(`${API_BASE}/searxng/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SearxngStatusDTO | null) => { if (d) setStatus(d); })
      .catch(() => {});
  };
  useEffect(refreshStatus, []);

  const poll = () => {
    const tick = () => {
      fetch(`${API_BASE}/searxng/install/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { running: boolean; log: string; error: string | null; url: string | null } | null) => {
          if (!d) return;
          setLog(d.log);
          setError(d.error);
          if (d.running) {
            setTimeout(tick, 1500);
          } else {
            setBusy(false);
            refreshStatus();
            if (d.url && !d.error && !notifiedRef.current) {
              notifiedRef.current = true;
              onInstalled(d.url);
            }
          }
        })
        .catch(() => setBusy(false));
    };
    tick();
  };

  const install = () => {
    setBusy(true);
    setError(null);
    setLog("");
    notifiedRef.current = false;
    fetch(`${API_BASE}/searxng/install`, { method: "POST" })
      .then(() => poll())
      .catch(() => setBusy(false));
  };

  const pollDocker = () => {
    const tick = () => {
      fetch(`${API_BASE}/searxng/install-docker/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { running: boolean; log: string; error: string | null; docker_available: boolean } | null) => {
          if (!d) return;
          setDockerLog(d.log);
          setDockerError(d.error);
          if (d.running) {
            setTimeout(tick, 2000);
          } else {
            setDockerBusy(false);
            // refreshStatus flips docker_desktop_installed → the primary button
            // becomes "Install SearXNG" for the user to click next.
            refreshStatus();
          }
        })
        .catch(() => setDockerBusy(false));
    };
    tick();
  };

  const installDocker = () => {
    setDockerBusy(true);
    setDockerError(null);
    setDockerLog("");
    fetch(`${API_BASE}/searxng/install-docker`, { method: "POST" })
      .then(() => pollDocker())
      .catch(() => setDockerBusy(false));
  };

  // Re-apply settings.yml into an already-running container. Useful when
  // /search?format=json returns 403 because Docker Desktop + WSL2 silently
  // dropped our bind-mounted config.
  const repair = () => {
    setRepairBusy(true);
    setRepairResult(null);
    fetch(`${API_BASE}/searxng/repair`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { success: boolean; output: string }) => {
        setRepairResult({ ok: d.success, message: d.output });
        refreshStatus();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setRepairResult({ ok: false, message });
      })
      .finally(() => setRepairBusy(false));
  };

  if (!status) return null;

  return (
    <div className="st2-ws-install">
      <div className="st2-ws-install-head">
        <span className="st2-ws-install-title">{t(`${WS}.installTitle`)}</span>
        {status.running && <span className="st2-ws-ok">● {t(`${WS}.running`)}</span>}
      </div>

      {!status.wsl_available ? (
        <p className="st2-ws-hint">{t(`${WS}.needWsl`)}</p>
      ) : !status.docker_desktop_installed ? (
        // Step 1 — Docker isn't installed yet. Download it (winget) or guide.
        status.winget_available ? (
          <>
            <p className="st2-ws-hint">{t(`${WS}.dockerAutoHint`)}</p>
            <div className="st2-ws-btn-row">
              <Button
                label={dockerBusy ? t(`${WS}.installingDocker`) : t(`${WS}.installDocker`)}
                onClick={installDocker}
                isDisabled={dockerBusy}
                isLoading={dockerBusy}
                variant="secondary"
                size="sm"
              />
            </div>
          </>
        ) : (
          <p className="st2-ws-hint">
            {t(`${WS}.dockerManualHint`)}{" "}
            <a href={status.docker_download_url} target="_blank" rel="noreferrer">
              {status.docker_download_url}
            </a>
          </p>
        )
      ) : (
        // Step 2 — Docker is installed. Offer the SearXNG install directly.
        <>
          <p className="st2-ws-hint">
            {status.docker_available ? t(`${WS}.installHint`) : t(`${WS}.dockerSetupHint`)}
          </p>
          <div className="st2-ws-btn-row">
            <Button
              label={busy
                ? t(`${WS}.installing`)
                : status.running
                  ? t(`${WS}.reinstall`)
                  : t(`${WS}.install`)}
              onClick={install}
              isDisabled={busy || repairBusy}
              isLoading={busy}
              variant="secondary"
              size="sm"
            />
            {status.running && (
              <Button
                label={repairBusy ? t(`${WS}.repairing`) : t(`${WS}.repair`)}
                onClick={repair}
                isDisabled={busy || repairBusy}
                isLoading={repairBusy}
                tooltip={t(`${WS}.repairHint`)}
                variant="secondary"
                size="sm"
              />
            )}
          </div>
          {status.running && (
            <p className="st2-ws-hint st2-ws-hint-sub">{t(`${WS}.repairHint`)}</p>
          )}
        </>
      )}

      {(dockerLog || dockerError) && (
        <pre className={`st2-ws-log${dockerError ? " err" : ""}`}>
          {dockerError ? `${dockerLog}\n${dockerError}` : dockerLog}
        </pre>
      )}

      {(log || error) && (
        <pre className={`st2-ws-log${error ? " err" : ""}`}>{error ? `${log}\n${error}` : log}</pre>
      )}

      {repairResult && (
        <pre className={`st2-ws-log${repairResult.ok ? "" : " err"}`}>{repairResult.message}</pre>
      )}
    </div>
  );
}
