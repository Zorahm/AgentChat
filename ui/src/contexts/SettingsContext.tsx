/** Settings context — single source of truth for shared settings state. */

import { createContext, useContext } from "react";

export interface ModelItem {
  id: string;
  name?: string | null;
  thinking?: boolean | null;
  thinking_types?: string[] | null;
  effort_levels?: string[] | null;
}

export interface SettingsContextValue {
  model: string;
  setModel: (id: string) => void;
  theme: string;
  /** Active UI language code ("" = follow OS-locale detection). */
  language: string;
  userName: string;
  thinkingEnabled: boolean;
  setThinkingEnabled: (v: boolean | ((prev: boolean) => boolean)) => void;
  effortLevel: string | null;
  setEffortLevel: (v: string | null | ((prev: string | null) => string | null)) => void;
  enabledProviders: Set<string>;
  models: ModelItem[];
  onboardingDone: boolean | null;
  /** Persist a partial settings object to the backend and refresh local state. */
  updateSettings: (partial: Record<string, unknown>) => Promise<void>;
  /** Re-fetch all settings from the backend. */
  refreshSettings: () => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsContext.Provider");
  return ctx;
}
