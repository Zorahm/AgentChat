/** Agent CRUD, backed by the /api/agents endpoints. Mirrors useProjects.ts. */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../utils/apiBase";
import type { Agent, AgentEditorMeta, AgentPreview, PromptMode } from "../types/agent";

const EMPTY_META: AgentEditorMeta = { variables: [], toggleable_modules: [] };

export interface AgentPatch {
  name?: string;
  color_from?: string;
  color_to?: string;
  system_prompt?: string;
  prompt_mode?: PromptMode;
  disabled_modules?: string[];
}

/** The unsaved editor state a preview is assembled from. */
export interface AgentDraft {
  name: string;
  system_prompt: string;
  prompt_mode: PromptMode;
  disabled_modules: string[];
}

export interface UseAgentsResult {
  agents: Agent[];
  loading: boolean;
  refresh: () => Promise<void>;
  createAgent: (id: string, name: string) => Promise<Agent | null>;
  updateAgent: (id: string, patch: AgentPatch) => Promise<Agent | null>;
  deleteAgent: (id: string) => Promise<void>;
  fetchEditorMeta: () => Promise<AgentEditorMeta>;
  fetchPreview: (draft: AgentDraft) => Promise<AgentPreview | null>;
}

export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/agents`);
      if (r.ok) setAgents((await r.json()) as Agent[]);
    } catch {
      /* offline — keep last known list */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createAgent = useCallback(
    async (id: string, name: string): Promise<Agent | null> => {
      try {
        const r = await fetch(`${API_BASE}/agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, name }),
        });
        if (!r.ok) return null;
        const agent = (await r.json()) as Agent;
        await refresh();
        return agent;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const updateAgent = useCallback(
    async (id: string, patch: AgentPatch): Promise<Agent | null> => {
      try {
        const r = await fetch(`${API_BASE}/agents/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!r.ok) return null;
        const agent = (await r.json()) as Agent;
        await refresh();
        return agent;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const deleteAgent = useCallback(
    async (id: string): Promise<void> => {
      try {
        await fetch(`${API_BASE}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {
        /* no-op */
      }
      await refresh();
    },
    [refresh],
  );

  const fetchEditorMeta = useCallback(async (): Promise<AgentEditorMeta> => {
    try {
      const r = await fetch(`${API_BASE}/agents/variables`);
      if (!r.ok) return EMPTY_META;
      return (await r.json()) as AgentEditorMeta;
    } catch {
      return EMPTY_META;
    }
  }, []);

  /** Assemble the prompt this draft would produce, using the same backend path
   * the chat route uses — so what the editor shows is what actually runs. */
  const fetchPreview = useCallback(async (draft: AgentDraft): Promise<AgentPreview | null> => {
    try {
      const r = await fetch(`${API_BASE}/agents/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) return null;
      return (await r.json()) as AgentPreview;
    } catch {
      return null;
    }
  }, []);

  return {
    agents,
    loading,
    refresh,
    createAgent,
    updateAgent,
    deleteAgent,
    fetchEditorMeta,
    fetchPreview,
  };
}
