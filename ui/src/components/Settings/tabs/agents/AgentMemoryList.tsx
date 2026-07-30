/** What this agent remembers: the facts it saved, editable by hand.
 *
 * Rows, not cards — this is dense data, and each fact is one line of text.
 * The list is loaded on mount rather than held in useAgents: a chat running
 * alongside the settings panel can write to it at any moment, so a cached copy
 * would be stale the first time the agent remembers something.
 *
 * Pinned facts sort first, matching the ranking the prompt block uses, so the
 * order here is what the agent actually sees.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowClockwise, PushPin, PushPinSlash, Trash } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { MemoryFact } from "../../../../types/agent";
import type { MemoryPatch } from "../../../../hooks/useAgents";

interface AgentMemoryListProps {
  agentId: string;
  fetchMemory: (agentId: string) => Promise<MemoryFact[]>;
  addMemory: (agentId: string, text: string, topic?: string) => Promise<MemoryFact | null>;
  updateMemory: (agentId: string, factId: number, patch: MemoryPatch) => Promise<MemoryFact | null>;
  deleteMemory: (agentId: string, factId: number) => Promise<void>;
}

export function AgentMemoryList({
  agentId,
  fetchMemory,
  addMemory,
  updateMemory,
  deleteMemory,
}: AgentMemoryListProps) {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setFacts(await fetchMemory(agentId));
    setLoading(false);
  }, [agentId, fetchMemory]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    const created = await addMemory(agentId, text);
    setBusy(false);
    if (created) {
      setDraft("");
      await reload();
    }
  };

  const togglePin = async (fact: MemoryFact) => {
    await updateMemory(agentId, fact.id, { pinned: !fact.pinned });
    await reload();
  };

  const remove = async (fact: MemoryFact) => {
    await deleteMemory(agentId, fact.id);
    await reload();
  };

  return (
    <div className="ag-field ag-memory">
      <div className="ag-memory-head">
        <span>{t("settings.agents.memoryTitle")}</span>
        <span className="ag-memory-count">
          {t("settings.agents.memoryCount", { count: facts.length })}
        </span>
        <Button
          label={t("settings.agents.memoryRefresh")}
          icon={<ArrowClockwise size={13} />}
          onClick={() => { void reload(); }}
          variant="ghost"
          size="sm"
        />
      </div>
      <span className="ag-hint">{t("settings.agents.memoryHint")}</span>

      {loading ? (
        <span className="ag-hint">{t("settings.agents.memoryLoading")}</span>
      ) : facts.length === 0 ? (
        <span className="ag-hint">{t("settings.agents.memoryEmpty")}</span>
      ) : (
        <ul className="ag-memory-list">
          {facts.map((fact) => (
            <li key={fact.id} className={`ag-memory-row${fact.pinned ? " ag-memory-row--pinned" : ""}`}>
              <span className="ag-memory-id">#{fact.id}</span>
              {fact.topic && <span className="ag-tag">{fact.topic}</span>}
              <span className="ag-memory-text">{fact.text}</span>
              <button
                className="ag-memory-btn"
                onClick={() => { void togglePin(fact); }}
                title={fact.pinned ? t("settings.agents.memoryUnpin") : t("settings.agents.memoryPin")}
              >
                {fact.pinned ? <PushPinSlash size={13} /> : <PushPin size={13} />}
              </button>
              <button
                className="ag-memory-btn ag-memory-btn--danger"
                onClick={() => { void remove(fact); }}
                title={t("settings.agents.memoryForget")}
              >
                <Trash size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="ag-memory-add">
        <TextInput
          label={t("settings.agents.memoryAdd")}
          isLabelHidden
          value={draft}
          onChange={setDraft}
          placeholder={t("settings.agents.memoryAddPlaceholder")}
        />
        <Button
          label={t("settings.agents.memoryAdd")}
          onClick={() => { void add(); }}
          isDisabled={busy || draft.trim() === ""}
          variant="secondary"
          size="sm"
        />
      </div>
    </div>
  );
}
