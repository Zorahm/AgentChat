/** The provider slice of settings, fetched for the first-run wizard.
 *
 * SettingsPanel keeps an equivalent copy of this glue because it also owns
 * every other tab's state; the wizard needs only providers, their models and
 * the default model, so it fetches its own rather than mounting the panel.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { API_BASE } from "../../utils/apiBase";
import type { SettingsData } from "../Settings/SettingsPanel";
import type { NewProvider } from "../Settings/tabs/providers/AddProviderForm";
import type { ProviderStatus } from "../Settings/tabs/providers/helpers";

export interface ProviderSetup {
  settings: SettingsData | null;
  statuses: ProviderStatus[];
  /** A /models round trip is in flight. */
  loading: boolean;
  error: string | null;
  refreshModels: () => Promise<void>;
  updateProvider: (id: string, patch: Record<string, unknown>) => Promise<boolean | undefined>;
  addProvider: (body: NewProvider) => Promise<boolean>;
  deleteProvider: (id: string) => Promise<boolean>;
  setDefaultModel: (modelId: string) => Promise<void>;
}

export function useProviderSetup(): ProviderSetup {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/models${refresh ? "?refresh=true" : ""}`);
      if (r.ok) {
        const d = await r.json();
        setSettings((prev) => (prev ? { ...prev, models: d.models ?? [] } : prev));
        setStatuses(d.providers ?? []);
      }
    } catch {
      /* connectivity is already reported by the settings load */
    } finally {
      setLoading(false);
    }
  }, []);

  // /settings answers with an empty model list — models come from /models. Keep
  // the ones already on screen so a save doesn't blank the list mid-step.
  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/settings`);
      if (!r.ok) {
        setError(t("settings.loadError", { status: r.status }));
        return;
      }
      const d = await r.json();
      setSettings((prev) => ({ ...d, models: d.models?.length ? d.models : prev?.models ?? [] }));
      setError(null);
    } catch {
      setError(t("onboarding.connectionError"));
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await loadSettings();
      await loadModels(false);
    })();
  }, [loadSettings, loadModels]);

  const updateProvider = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      setError(null);
      const r = await fetch(`${API_BASE}/settings/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        setError(t("settings.saveError", { status: r.status }));
        return;
      }
      await loadSettings();
      // Entering a key is the whole point of this screen, so ask the provider
      // for its models right away instead of waiting out the fetcher's TTL.
      await loadModels("api_key" in patch);
      return true;
    },
    [t, loadSettings, loadModels],
  );

  const failWithDetail = useCallback(async (r: Response) => {
    try {
      const j = await r.json();
      setError(typeof j.detail === "string" ? j.detail : `HTTP ${r.status}`);
    } catch {
      setError(`HTTP ${r.status}`);
    }
  }, []);

  const addProvider = useCallback(
    async (body: NewProvider) => {
      setError(null);
      const r = await fetch(`${API_BASE}/settings/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        await failWithDetail(r);
        return false;
      }
      await loadSettings();
      await loadModels(true);
      return true;
    },
    [failWithDetail, loadSettings, loadModels],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      setError(null);
      const r = await fetch(`${API_BASE}/settings/providers/${id}`, { method: "DELETE" });
      if (!r.ok) {
        await failWithDetail(r);
        return false;
      }
      await loadSettings();
      return true;
    },
    [failWithDetail, loadSettings],
  );

  const setDefaultModel = useCallback(
    async (modelId: string) => {
      setError(null);
      const r = await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_model: modelId }),
      });
      if (!r.ok) {
        setError(t("settings.saveError", { status: r.status }));
        return;
      }
      await loadSettings();
    },
    [t, loadSettings],
  );

  return {
    settings,
    statuses,
    loading,
    error,
    refreshModels: () => loadModels(true),
    updateProvider,
    addProvider,
    deleteProvider,
    setDefaultModel,
  };
}
