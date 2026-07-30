/** Live reachability of the backend, for the Settings nav status dot.
 *
 * The dot used to be a hardcoded green circle — it said "online" even with the
 * sidecar dead. This polls /api/health, which is the same endpoint the desktop
 * shell uses to tell a live backend from a stale one, and reports its version
 * so a mismatched sidecar is visible too.
 */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../utils/apiBase";

const POLL_MS = 8000;
const TIMEOUT_MS = 4000;

export type BackendState = "checking" | "online" | "offline";

export interface BackendStatus {
  state: BackendState;
  /** Backend build version, when it answered. */
  version: string;
  refresh: () => void;
}

/** Poll the backend while *active*. Pass false to stop (e.g. panel closed). */
export function useBackendStatus(active = true): BackendStatus {
  const [state, setState] = useState<BackendState>("checking");
  const [version, setVersion] = useState("");
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const check = async () => {
      // fetch() only rejects on a network error, and a wedged backend can
      // accept the connection then never answer — so cap the wait explicitly
      // rather than leaving the dot on "checking" forever.
      const abort = new AbortController();
      const timer = window.setTimeout(() => abort.abort(), TIMEOUT_MS);
      try {
        const r = await fetch(`${API_BASE}/health`, { signal: abort.signal });
        if (cancelled) return;
        if (r.ok) {
          const data = (await r.json()) as { status?: string; version?: string };
          setVersion(data.version ?? "");
          setState("online");
        } else {
          setState("offline");
        }
      } catch {
        if (!cancelled) setState("offline");
      } finally {
        window.clearTimeout(timer);
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active, nonce]);

  return { state, version, refresh };
}
