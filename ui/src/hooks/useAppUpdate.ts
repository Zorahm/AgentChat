/** App-update orchestration for the desktop (Tauri) shell.
 *
 * On mount we check the release endpoint exactly once. If something newer
 * exists, the sidebar shows a banner offering to restart-and-update or to
 * dismiss until the next launch. The actual check/install lives in
 * `utils/updater`; this hook only owns the UI-facing state machine.
 *
 * "Install later" dismisses for the current session only — the next launch
 * checks again and re-surfaces the banner if the update is still pending.
 */

import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type UpdateStatus } from "../utils/updater";
import { isTauri } from "../utils/tauri";

export interface AppUpdate {
  status: UpdateStatus;
  /** True while a banner should be visible (available / in-progress / failed install). */
  visible: boolean;
  /** True while download or install is running — buttons should be disabled. */
  busy: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
}

export function useAppUpdate(): AppUpdate {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [dismissed, setDismissed] = useState(false);
  // True once the user clicked install — gates whether an error is shown.
  // A failed startup check (e.g. offline) must stay silent.
  const [installTried, setInstallTried] = useState(false);

  // One-shot check at startup, desktop only.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      const result = await checkForUpdate();
      if (!cancelled) setStatus(result);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(async () => {
    setInstallTried(true);
    // Accumulate byte progress into a percentage, mirroring AboutTab.
    let done = 0;
    let total = 0;
    await installUpdate((s) => {
      if (s.state === "downloading") {
        if (s.total) total = s.total;
        done += s.progress;
        const progress = total ? Math.round((done / total) * 100) : 0;
        setStatus({ state: "downloading", progress });
      } else {
        setStatus(s);
      }
    });
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);

  const busy = status.state === "downloading" || status.state === "installing";
  const visible =
    !dismissed &&
    (status.state === "available" ||
      status.state === "downloading" ||
      status.state === "installing" ||
      (status.state === "error" && installTried));

  return { status, visible, busy, install, dismiss };
}
