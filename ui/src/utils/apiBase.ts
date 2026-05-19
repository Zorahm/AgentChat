/** Environment-aware API base URL.
 *
 * Priority: localStorage override → Tauri default → Vite dev proxy.
 * The localStorage key "agentchat.backendUrl" enables mobile/remote backend use.
 */

function detectApiBase(): string {
  const override = typeof localStorage !== "undefined"
    ? localStorage.getItem("agentchat.backendUrl")
    : null;
  if (override) return override.replace(/\/$/, "") + "/api";

  // Tauri v2 dropped window.__TAURI__; the reliable signal is __TAURI_INTERNALS__
  // (always injected once the IPC bridge initialises). window.isTauri is set on
  // newer v2 builds; __TAURI__ is kept as a v1 fallback.
  if (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window ||
      "isTauri" in window ||
      "__TAURI__" in window)
  ) {
    return "http://127.0.0.1:8787/api";
  }
  return "/api";
}

export const API_BASE = detectApiBase();

/** Call after changing the localStorage key to reload with the new base. */
export function setBackendUrl(url: string) {
  if (url) {
    localStorage.setItem("agentchat.backendUrl", url.replace(/\/$/, ""));
  } else {
    localStorage.removeItem("agentchat.backendUrl");
  }
  window.location.reload();
}
