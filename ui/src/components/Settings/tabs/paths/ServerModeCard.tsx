/** Point this client at a backend running elsewhere (a VDS, another PC).
 *
 * The agent's shell, files and tools all execute wherever the backend lives, so
 * flipping this moves the whole working environment to the server and leaves
 * the app as a viewer. On desktop it also stops the Tauri shell from spawning
 * its bundled sidecar — see utils/serverMode.ts for why two stores are written.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudArrowUp, Warning } from "@phosphor-icons/react";
import { Switch } from "@astryxdesign/core/Switch";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  disableServerMode,
  enableServerMode,
  getServerMode,
  probeBackend,
} from "../../../../utils/serverMode";

export function ServerModeCard() {
  const { t } = useTranslation();
  const initial = getServerMode();
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Verify before committing: an unreachable address would otherwise reload
    // the app into a backend that never answers, and Settings is reached
    // *through* that backend.
    const result = await probeBackend(url, token);
    if (!result.ok) {
      setError(t(result.errorKey));
      setBusy(false);
      return;
    }
    await enableServerMode(url, token); // reloads the page
  }, [url, token, t]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    await disableServerMode(); // reloads the page
  }, []);

  if (initial.enabled) {
    return (
      <div className="st2-remote-conn">
        <div className="st2-remote-conn-head">
          <CloudArrowUp size={16} />
          <div className="st2-remote-conn-titles">
            <div className="st2-remote-conn-title">{t("settings.paths.serverModeTitle")}</div>
            <div className="st2-remote-conn-sub">{t("settings.paths.serverModeOnHint")}</div>
          </div>
          <Switch
            label={t("settings.paths.serverModeTitle")}
            isLabelHidden
            value
            isDisabled={busy}
            onChange={() => { void handleDisconnect(); }}
          />
        </div>
        <div className="st2-server-current">
          <span className="lab">{t("settings.paths.serverModeConnectedTo")}</span>
          <code>{initial.url}</code>
        </div>
        <p className="st2-server-warn">
          <Warning size={14} weight="fill" />
          {t("settings.paths.serverModeShellWarning")}
        </p>
      </div>
    );
  }

  return (
    <div className="st2-remote-conn">
      <div className="st2-remote-conn-head">
        <CloudArrowUp size={16} />
        <div className="st2-remote-conn-titles">
          <div className="st2-remote-conn-title">{t("settings.paths.serverModeTitle")}</div>
          <div className="st2-remote-conn-sub">{t("settings.paths.serverModeHint")}</div>
        </div>
      </div>

      {error && <div className="st2-server-error">{error}</div>}

      <div className="st2-server-form">
        <TextInput
          label={t("settings.paths.serverModeUrlLabel")}
          type="text"
          value={url}
          onChange={(value: string) => { setError(null); setUrl(value); }}
          placeholder={t("settings.paths.serverModeUrlPlaceholder")}
        />
        <TextInput
          label={t("settings.paths.serverModeTokenLabel")}
          type="password"
          value={token}
          onChange={(value: string) => { setError(null); setToken(value); }}
          placeholder={t("settings.paths.serverModeTokenPlaceholder")}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") void handleConnect();
          }}
        />
        <Button
          label={busy ? t("settings.paths.serverModeConnecting") : t("settings.paths.serverModeConnect")}
          onClick={() => { void handleConnect(); }}
          isDisabled={busy || !url.trim()}
          variant="primary"
        />
      </div>
    </div>
  );
}
