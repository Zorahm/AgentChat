/** Agent CRUD, backed by the /api/agents endpoints. Mirrors useProjects.ts. */

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../utils/apiBase";
import { asArray } from "../utils/asArray";
import type {
  Agent,
  AgentEditorMeta,
  AgentPreview,
  MemoryFact,
  PromptMode,
  ToolPolicy,
} from "../types/agent";

const EMPTY_META: AgentEditorMeta = { variables: [], toggleable_modules: [], available_tools: [] };

export interface AgentPatch {
  name?: string;
  color_from?: string;
  color_to?: string;
  system_prompt?: string;
  prompt_mode?: PromptMode;
  disabled_modules?: string[];
  tool_policy?: ToolPolicy;
  /** Empty = unrestricted. Sent on every save so clearing the whitelist sticks. */
  allowed_tools?: string[];
  memory_enabled?: boolean;
  user_persona?: string;
  greeting?: string;
  /** `null` is meaningful — it hands temperature back to the global setting.
   * The backend distinguishes an absent key from an explicit null, so this
   * must not be dropped when serialising. */
  temperature?: number | null;
  model?: string;
}

/** The unsaved editor state a preview is assembled from. */
export interface AgentDraft {
  name: string;
  system_prompt: string;
  prompt_mode: PromptMode;
  disabled_modules: string[];
  user_persona: string;
}

export interface MemoryPatch {
  text?: string;
  topic?: string;
  pinned?: boolean;
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
  fetchMemory: (agentId: string) => Promise<MemoryFact[]>;
  addMemory: (agentId: string, text: string, topic?: string) => Promise<MemoryFact | null>;
  updateMemory: (agentId: string, factId: number, patch: MemoryPatch) => Promise<MemoryFact | null>;
  deleteMemory: (agentId: string, factId: number) => Promise<void>;
  fetchGreeting: (agentId: string) => Promise<string>;
}

export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/agents`);
      // A 200 is not a promise of a list — see utils/asArray. Storing a
      // non-array here took the whole chat column down: ModelSelector calls
      // agents.find() on every render.
      if (r.ok) setAgents(asArray<Agent>(await r.json()));
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

  // ── memory ──────────────────────────────────────────────────────────
  // Not held in state: the list is only ever open in one editor at a time, and
  // caching it here would go stale the moment the agent remembers something in
  // a chat running alongside the settings panel.

  const memoryUrl = (agentId: string, factId?: number) =>
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/memory` +
    (factId === undefined ? "" : `/${factId}`);

  const fetchMemory = useCallback(async (agentId: string): Promise<MemoryFact[]> => {
    try {
      const r = await fetch(memoryUrl(agentId));
      if (!r.ok) return [];
      return asArray<MemoryFact>(await r.json());
    } catch {
      return [];
    }
  }, []);

  const addMemory = useCallback(
    async (agentId: string, text: string, topic = ""): Promise<MemoryFact | null> => {
      try {
        const r = await fetch(memoryUrl(agentId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, topic }),
        });
        if (!r.ok) return null;
        return (await r.json()) as MemoryFact;
      } catch {
        return null;
      }
    },
    [],
  );

  const updateMemory = useCallback(
    async (agentId: string, factId: number, patch: MemoryPatch): Promise<MemoryFact | null> => {
      try {
        const r = await fetch(memoryUrl(agentId, factId), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!r.ok) return null;
        return (await r.json()) as MemoryFact;
      } catch {
        return null;
      }
    },
    [],
  );

  const deleteMemory = useCallback(async (agentId: string, factId: number): Promise<void> => {
    try {
      await fetch(memoryUrl(agentId, factId), { method: "DELETE" });
    } catch {
      /* no-op */
    }
  }, []);

  /** The greeting with its `{user}` / `{user_persona}` variables resolved.
   * Rendered by the backend so the template syntax has exactly one
   * implementation. */
  const fetchGreeting = useCallback(async (agentId: string): Promise<string> => {
    try {
      const r = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/greeting`, {
        method: "POST",
      });
      if (!r.ok) return "";
      return ((await r.json()) as { text: string }).text;
    } catch {
      return "";
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
    fetchMemory,
    addMemory,
    updateMemory,
    deleteMemory,
    fetchGreeting,
  };
}
