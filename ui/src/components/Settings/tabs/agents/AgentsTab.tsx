/** Agents settings tab — persona profiles a chat can be attached to.
 *
 * A persona is a prompt *template*: `{date}`, `{tools}` and friends resolve on
 * every request, and `append` mode keeps AgentChat's tool/sandbox/safety rules
 * underneath. See backend/agent/prompt/variables.py.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Robot, Plus } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { useAgents } from "../../../../hooks/useAgents";
import { AgentAvatar } from "../../../AgentAvatar";
import type { AgentEditorMeta } from "../../../../types/agent";
import type { SettingsData } from "../../SettingsPanel";
import { AddAgentForm } from "./AddAgentForm";
import { AgentCard } from "./AgentCard";

const DEFAULT_AGENT_ID = "default";
const EMPTY_META: AgentEditorMeta = { variables: [], toggleable_modules: [], available_tools: [] };

interface AgentsTabProps {
  /** For the two fields an agent can override: the global temperature it falls
   * back to, and the model ids it may pin itself to. */
  settings: SettingsData;
}

export function AgentsTab({ settings }: AgentsTabProps) {
  const { t } = useTranslation();
  const {
    agents, loading, createAgent, updateAgent, deleteAgent, fetchEditorMeta, fetchPreview,
    fetchMemory, addMemory, updateMemory, deleteMemory,
  } = useAgents();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [meta, setMeta] = useState<AgentEditorMeta>(EMPTY_META);

  // Static for a given build — fetched once, shared by every open editor.
  useEffect(() => {
    void fetchEditorMeta().then(setMeta);
  }, [fetchEditorMeta]);

  const onDelete = async (id: string) => {
    await deleteAgent(id);
    if (expanded === id) setExpanded(null);
  };

  const customAgents = agents.filter((a) => a.id !== DEFAULT_AGENT_ID);
  const builtIn = agents.find((a) => a.id === DEFAULT_AGENT_ID);
  const availableModels = settings.models.map((m) => m.id);

  return (
    <>
      <div className="st2-row-between">
        <div>
          <h3 className="st2-h">
            <Robot size={18} weight="duotone" style={{ verticalAlign: "-3px" }} /> {t("settings.agents.title")}
          </h3>
          <p className="st2-sub">{t("settings.agents.description")}</p>
        </div>
      </div>

      <div className="ag-list">
        {/* The built-in persona is fixed: it is the known-good fallback a chat
            lands on when its agent was deleted, so it stays uneditable. */}
        {builtIn && (
          <div className="ag-card ag-card--locked">
            <div className="ag-head ag-head--static">
              <AgentAvatar name={builtIn.name} colorFrom={builtIn.color_from} colorTo={builtIn.color_to} size={26} />
              <span className="ag-name">{builtIn.name}</span>
              <span className="ag-tag">{t("settings.agents.defaultTag")}</span>
              <span className="ag-locked-hint">{t("settings.agents.defaultLockedHint")}</span>
            </div>
          </div>
        )}

        {customAgents.map((a) => (
          <AgentCard
            // Keyed by id so a list refresh never remounts (and never wipes)
            // an open editor, while switching agents starts a clean draft.
            key={a.id}
            agent={a}
            meta={meta}
            open={expanded === a.id}
            onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
            onDelete={() => onDelete(a.id)}
            onSave={(patch) => updateAgent(a.id, patch)}
            fetchPreview={fetchPreview}
            globalTemperature={settings.temperature}
            availableModels={availableModels}
            memory={{ fetchMemory, addMemory, updateMemory, deleteMemory }}
          />
        ))}
      </div>

      {customAgents.length === 0 && !adding && (
        <p className="ag-hint" style={{ marginTop: 0 }}>{t("settings.agents.empty")}</p>
      )}

      {adding ? (
        <AddAgentForm
          existingIds={new Set(agents.map((a) => a.id))}
          onCancel={() => setAdding(false)}
          onAdded={() => setAdding(false)}
          createAgent={createAgent}
        />
      ) : (
        <Button
          label={t("settings.agents.addAgent")}
          icon={<Plus size={14} />}
          onClick={() => setAdding(true)}
          isDisabled={loading}
          variant="secondary"
          className="ag-add-btn"
        />
      )}
    </>
  );
}
