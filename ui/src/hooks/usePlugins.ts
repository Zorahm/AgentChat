/** Agent Plugins CRUD, backed by the /api/plugins endpoints. Mirrors useAgents.ts. */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../utils/apiBase";
import { asArray } from "../utils/asArray";
import type { Plugin, PluginLocation } from "../types/plugin";

/** Install calls resolve to the backend's message, or null when they worked. */
type InstallOutcome = Promise<string | null>;

export interface UsePluginsResult {
  plugins: Plugin[];
  location: PluginLocation | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  installFromGithub: (source: string) => InstallOutcome;
  installLocal: (path: string) => InstallOutcome;
  installArchive: (file: File) => InstallOutcome;
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
  remove: (name: string) => InstallOutcome;
}

/** Pull the FastAPI `detail` out of a failed response, falling back to the status. */
async function failureMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string" && detail) return detail;
    }
  } catch {
    /* not JSON — fall through to the status line */
  }
  return `HTTP ${response.status}`;
}

export function usePlugins(): UsePluginsResult {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [location, setLocation] = useState<PluginLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/plugins`);
      if (!r.ok) {
        setError(await failureMessage(r));
        return;
      }
      setPlugins(asArray<Plugin>(await r.json()));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        const r = await fetch(`${API_BASE}/plugins/location`);
        if (r.ok) setLocation((await r.json()) as PluginLocation);
      } catch {
        /* the hint line just stays empty */
      }
    })();
  }, [refresh]);

  /** Every mutation ends in a refresh: one change can add or remove several
   *  skills and servers at once, and only the backend knows the new set. */
  const mutate = useCallback(
    async (url: string, init: RequestInit): InstallOutcome => {
      try {
        const r = await fetch(url, init);
        if (!r.ok) return await failureMessage(r);
        await refresh();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "network error";
      }
    },
    [refresh],
  );

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const installFromGithub = useCallback(
    (source: string) => mutate(`${API_BASE}/plugins/install`, json({ source })),
    [mutate],
  );

  const installLocal = useCallback(
    (path: string) => mutate(`${API_BASE}/plugins/install-local`, json({ path })),
    [mutate],
  );

  const installArchive = useCallback(
    (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return mutate(`${API_BASE}/plugins/upload`, { method: "POST", body: form });
    },
    [mutate],
  );

  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      const message = await mutate(`${API_BASE}/plugins/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (message) setError(message);
    },
    [mutate],
  );

  const remove = useCallback(
    (name: string) =>
      mutate(`${API_BASE}/plugins/${encodeURIComponent(name)}`, { method: "DELETE" }),
    [mutate],
  );

  return {
    plugins,
    location,
    loading,
    error,
    refresh,
    installFromGithub,
    installLocal,
    installArchive,
    setEnabled,
    remove,
  };
}
