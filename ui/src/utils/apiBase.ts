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

/** The persisted backend-URL override ("" when none). The mobile APK gates its
 *  first run on this: with no override there's no backend to talk to, so the
 *  connect screen is shown before any API call. */
export function getBackendOverride(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem("agentchat.backendUrl") ?? "";
}

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

/** Append the remote-access token as a `?token=` query param. For URLs handed
 *  straight to the browser (<img>/<iframe> src) — those requests are issued by
 *  the browser itself, so installApiAuth's fetch wrapper never sees them and
 *  can't attach the Authorization header. No-op without a token (desktop
 *  loopback, which doesn't need one). Only the backend's file-serving/preview
 *  routes accept this fallback (see _QUERY_TOKEN_PATHS in main.py). */
export function withToken(url: string): string {
  const token = getToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
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
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = getToken();
    const isApi = isApiRequest(input);
    let req: RequestInfo | URL = input;
    let reqInit = init;
    if (token && isApi) {
      if (input instanceof Request) {
        const headers = new Headers(input.headers);
        if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
        req = new Request(input, { headers });
      } else {
        const headers = new Headers(init?.headers);
        if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
        reqInit = { ...init, headers };
      }
    }
    try {
      const resp = await original(req, reqInit);
      if (isApi && resp.status === 401) reportBackendDisconnected("token");
      return resp;
    } catch (err) {
      if (isApi) reportBackendDisconnected("network");
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Backend-disconnect signaling — lets the remote/APK client (which talks to a
// backend over a token instead of loopback) offer a "reconnect" prompt
// instead of silently failing requests when the token expires or the network
// drops. Desktop loopback never has a backend override, so this is inert there.
// ---------------------------------------------------------------------------

const DISCONNECT_EVENT = "agentchat:backend-disconnected";
export type BackendDisconnectReason = "token" | "network";

let disconnectReported = false;

function reportBackendDisconnected(reason: BackendDisconnectReason): void {
  if (disconnectReported) return;
  if (!getBackendOverride()) return; // desktop loopback — not a remote client
  disconnectReported = true;
  window.dispatchEvent(new CustomEvent<BackendDisconnectReason>(DISCONNECT_EVENT, { detail: reason }));
}

/** Subscribe to backend-disconnect events. Returns an unsubscribe function. */
export function onBackendDisconnected(handler: (reason: BackendDisconnectReason) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<BackendDisconnectReason>).detail);
  window.addEventListener(DISCONNECT_EVENT, listener);
  return () => window.removeEventListener(DISCONNECT_EVENT, listener);
}

/** Allow reporting again after the user dismisses the reconnect prompt. */
export function resetBackendDisconnected(): void {
  disconnectReported = false;
}
