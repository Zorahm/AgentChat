import { useCallback, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../utils/tauri";
import { Button } from "@astryxdesign/core/Button";

interface RestartBackendButtonProps {
  /** Called after a successful restart — e.g. to re-fetch connection info. */
  onDone?: () => void;
}

/** Restarts the local backend via the `restart_backend` Tauri command.
 *  Renders nothing outside Tauri (the backend is the host's concern there). */
export function RestartBackendButton({ onDone }: RestartBackendButtonProps) {
  const { t } = useTranslation();
  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await invoke("restart_backend");
      onDone?.();
    } catch {
      /* restart failed — leave UI as-is so the user can retry */
    } finally {
      setRestarting(false);
    }
  }, [onDone]);

  if (!isTauri()) return null;

  return (
    <Button
      label={restarting ? t("settings.backend.restarting") : t("settings.backend.restart")}
      icon={<ArrowClockwise weight="bold" />}
      isLoading={restarting}
      isDisabled={restarting}
      onClick={() => { void handleRestart(); }}
      variant="secondary"
    />
  );
}
