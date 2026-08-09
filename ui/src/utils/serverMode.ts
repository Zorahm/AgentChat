/** Server mode — this client talks to a backend running somewhere else.
 *
 * The agent's shell and file tools execute wherever the backend is, so pointing
 * the app at a VDS moves the whole working environment there; the desktop app
 * becomes a viewer. Two stores have to agree for that to hold:
 *
 *   - **localStorage** — read synchronously by `apiBase.detectApiBase()` while
 *     the module graph loads, long before any async call could resolve.
 *   - **a file in the Tauri config dir** — read by the Rust shell *before* the
 *     webview exists, to decide whether to spawn the local backend sidecar at
 *     all. It cannot see localStorage.
 *
 * Neither can be derived from the other at the moment it is needed, so both are
 * written — from here and nowhere else. `syncToShell()` re-pushes the browser's
 * view at startup so a hand-cleared localStorage can't leave the shell
 * suppressing a sidecar nobody is talking to.
 */

import { getBackendOverride, setBackendUrl, setToken } from "./apiBase";
import { isAndroidTauri, isTauri } from "./tauri";

export interface ServerModeState {
  enabled: boolean;
  /** Backend base URL, no trailing slash. Empty when running locally. */
  url: string;
}

export function getServerMode(): ServerModeState {
  const url = getBackendOverride();
  return { enabled: Boolean(url), url };
}

/** Tell the Rust shell whether to spawn its bundled backend on next launch.
 *  No-op for the PWA and the APK: neither carries a sidecar to suppress, and
 *  the command is only registered on desktop. */
async function writeShellState(enabled: boolean, url: string): Promise<void> {
  if (!isTauri() || isAndroidTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_server_mode", { enabled, url });
  } catch {
    // An older shell without the command, or a webview that denied the IPC.
    // The browser-side override still works — the cost is a redundant local
    // sidecar, not a broken connection.
  }
}

/** Verify a backend answers at `url` with `token`, without committing to it.
 *
 * `/api/wsl/status` sits behind the remote-access guard, so a 200 proves three
 * things at once: reachable, token accepted, remote access on. Returns a
 * translation key on failure so the caller owns the wording. */
export async function probeBackend(
  url: string,
  token: string,
): Promise<{ ok: true } | { ok: false; errorKey: string }> {
  const base = url.trim().replace(/\/+$/, "");
  if (!base) return { ok: false, errorKey: "mobile.errUrlRequired" };
  try {
    const resp = await fetch(`${base}/api/wsl/status`, {
      headers: token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {},
    });
    if (resp.status === 401) return { ok: false, errorKey: "mobile.errToken" };
    if (!resp.ok) return { ok: false, errorKey: "mobile.errGeneric" };
    return { ok: true };
  } catch {
    return { ok: false, errorKey: "mobile.errUnreachable" };
  }
}

/** Switch this client over to a remote backend and reload into it.
 *
 * Order is load-bearing: the token and the shell file must both be committed
 * before `setBackendUrl` reloads the page out from under us. */
export async function enableServerMode(url: string, token: string): Promise<void> {
  const base = url.trim().replace(/\/+$/, "");
  setToken(token.trim());
  await writeShellState(true, base);
  setBackendUrl(base); // persists and reloads
}

/** Drop back to the backend bundled with this app and reload into it. */
export async function disableServerMode(): Promise<void> {
  setToken("");
  await writeShellState(false, "");
  setBackendUrl(""); // clears the override and reloads
}

/** Re-assert the browser's view of server mode onto the shell. Call once at
 *  startup: the two stores are written together, but only one of them survives
 *  a user clearing site data. */
export function syncToShell(): void {
  const { enabled, url } = getServerMode();
  void writeShellState(enabled, url);
}
