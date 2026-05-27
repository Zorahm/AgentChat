/** Environment-aware API base URL + remote-access token handling.
 *
 * Priority: localStorage override → Tauri default → Vite dev proxy.
 * The localStorage key "agentchat.backendUrl" enables mobile/remote backend use.
 * When the UI is served from the backend itself (phone/PWA), API_BASE stays the
 * same-origin "/api" and only the Bearer token is needed.
 */

import { isTauri } from "./tauri";

const TOKEN_KEY = "agentchat.token";

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

// ---------------------------------------------------------------------------
// remote-access token
// ---------------------------------------------------------------------------

export function getToken(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string) {
  if (typeof localStorage === "undefined") return;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

/** Pull a `?token=…` out of the pairing link, persist it, and scrub the address
 *  bar so the secret isn't left visible or bookmarked. Call once at startup. */
export function captureTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return;
  setToken(token);
  params.delete("token");
  const qs = params.toString();
  const clean = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState({}, "", clean);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isApiRequest(input: RequestInfo | URL): boolean {
  const u = urlOf(input);
  if (u.startsWith(API_BASE)) return true; // absolute (Tauri/override) or "/api"
  if (u === "/api" || u.startsWith("/api/")) return true;
  if (typeof window !== "undefined" && u.startsWith(`${window.location.origin}/api`)) return true;
  return false;
}

/** Attach the Bearer token to API requests. Installed once at startup so the
 *  scattered fetch() call sites don't each need to know about auth. Loopback
 *  (desktop) has no token, so this is a no-op there. */
export function installApiAuth(): void {
  if (typeof window === "undefined") return;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = getToken();
    if (!token || !isApiRequest(input)) return original(input, init);
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
      return original(new Request(input, { headers }));
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return original(input, { ...init, headers });
  };
}
