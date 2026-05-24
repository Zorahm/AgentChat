/** Environment-aware API base URL.
 *
 * Priority: localStorage override → Tauri default → Vite dev proxy.
 * The localStorage key "agentchat.backendUrl" enables mobile/remote backend use.
 */

import { isTauri } from "./tauri";

function detectApiBase(): string {
  const override = typeof localStorage !== "undefined"
    ? localStorage.getItem("agentchat.backendUrl")
    : null;
  if (override) return override.replace(/\/$/, "") + "/api";

  if (isTauri()) {
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
