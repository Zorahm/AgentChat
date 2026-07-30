/** One agent row: collapsed summary, expanded editor, save/delete.
 *
 * The card owns the draft. It deliberately does NOT sync local state back from
 * props: the list refetches after every save, and an effect keyed on the agent
 * object used to fire in *every* open card, wiping unsaved edits in one card
 * when another was saved. AgentsTab keys this component by id, so switching
 * agents remounts it and a plain refresh leaves the draft alone.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, CaretRight, Trash } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { AgentAvatar } from "../../../AgentAvatar";
import type { AgentDraft, AgentPatch, MemoryPatch } from "../../../../hooks/useAgents";
import type {
  Agent,
  AgentEditorMeta,
  AgentPreview,
  MemoryFact,
  PromptMode,
  ToolPolicy,
} from "../../../../types/agent";
import { AgentBasics } from "./AgentBasics";
import { AgentMemoryList } from "./AgentMemoryList";
import { PersonaEditor } from "./PersonaEditor";
import { RpFields } from "./RpFields";
import { ToolPolicyPicker } from "./ToolPolicyPicker";

/** Roleplay temperature. High enough to stop the model falling into its
 * assistant register, below the range where small models start losing grammar. */
const RP_TEMPERATURE = 1.0;

type EditorTab = "basics" | "prompt" | "rp" | "memory";

/** The memory CRUD callbacks, forwarded from useAgents. Grouped so the card's
 * prop list doesn't grow four more entries. */
export interface MemoryActions {
  fetchMemory: (agentId: string) => Promise<MemoryFact[]>;
  addMemory: (agentId: string, text: string, topic?: string) => Promise<MemoryFact | null>;
  updateMemory: (agentId: string, factId: number, patch: MemoryPatch) => Promise<MemoryFact | null>;
  deleteMemory: (agentId: string, factId: number) => Promise<void>;
}

interface AgentCardProps {
  agent: Agent;
  open: boolean;
  meta: AgentEditorMeta;
  globalTemperature: number;
  availableModels: string[];
  memory: MemoryActions;
  onToggle: () => void;
  onDelete: () => Promise<void>;
  onSave: (patch: AgentPatch) => Promise<Agent | null>;
  fetchPreview: (draft: AgentDraft) => Promise<AgentPreview | null>;
}

export function AgentCard({
  agent, open, meta, globalTemperature, availableModels, memory,
  onToggle, onDelete, onSave, fetchPreview,
}: AgentCardProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(agent.name);
  const [colorFrom, setColorFrom] = useState(agent.color_from);
  const [colorTo, setColorTo] = useState(agent.color_to);
  const [persona, setPersona] = useState(agent.system_prompt);
  const [mode, setMode] = useState<PromptMode>(agent.prompt_mode);
  const [disabledModules, setDisabledModules] = useState<string[]>(agent.disabled_modules);
  // Defaults applied here, not in the type: a record from an older backend
  // carries none of these, and seeding state with `undefined` would blow up on
  // the first `temperature.toFixed()` / `greeting.trim()`.
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy>(agent.tool_policy ?? "full");
  const [memoryEnabled, setMemoryEnabled] = useState(agent.memory_enabled ?? false);
  const [userPersona, setUserPersona] = useState(agent.user_persona ?? "");
  const [greeting, setGreeting] = useState(agent.greeting ?? "");
  const [temperature, setTemperature] = useState<number | null>(agent.temperature ?? null);
  const [model, setModel] = useState(agent.model ?? "");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<EditorTab>("basics");

  const draft: AgentDraft = {
    name,
    system_prompt: persona,
    prompt_mode: mode,
    disabled_modules: disabledModules,
    user_persona: userPersona,
  };

  /** One click for the whole roleplay setup. Only touches the switches — the
   * persona text is the user's and is never overwritten. */
  const applyRpPreset = () => {
    setMode("replace");
    setToolPolicy("memory_only");
    setMemoryEnabled(true);
    setTemperature(RP_TEMPERATURE);
  };

  const isRpShaped =
    mode === "replace" && toolPolicy === "memory_only" && memoryEnabled;

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const result = await onSave({
        name: name.trim() || agent.name,
        color_from: colorFrom,
        color_to: colorTo,
        system_prompt: persona,
        prompt_mode: mode,
        disabled_modules: disabledModules,
        tool_policy: toolPolicy,
        memory_enabled: memoryEnabled,
        user_persona: userPersona,
        greeting,
        // Explicitly sent even when null — that is what hands temperature back
        // to the global setting, and the backend tells absent from null.
        temperature,
        model,
      });
      if (!result) setSaveErr(t("settings.agents.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const hasPersona = agent.system_prompt.trim() !== "";

  return (
    <div className={`ag-card${open ? " ag-card--open" : ""}`}>
      <div className="ag-head" onClick={onToggle}>
        <AgentAvatar name={agent.name} colorFrom={agent.color_from} colorTo={agent.color_to} size={26} />
        <span className="ag-name">{agent.name}</span>
        {hasPersona && (
          <span className={`ag-tag${agent.prompt_mode === "replace" ? " ag-tag--override" : ""}`}>
            {agent.prompt_mode === "replace"
              ? t("settings.agents.modeReplaceTag")
              : t("settings.agents.modeAppendTag")}
          </span>
        )}
        {agent.disabled_modules.length > 0 && (
          <span className="ag-tag" title={t("settings.agents.modulesOffHint")}>
            −{agent.disabled_modules.length}
          </span>
        )}
        {agent.tool_policy != null && agent.tool_policy !== "full" && (
          <span className="ag-tag" title={t("settings.agents.toolPolicyTagHint")}>
            {agent.tool_policy === "memory_only"
              ? t("settings.agents.toolPolicyMemoryTag")
              : t("settings.agents.toolPolicyNoneTag")}
          </span>
        )}
        {agent.memory_enabled && (
          <span className="ag-tag" title={t("settings.agents.memoryTagHint")}>
            {t("settings.agents.memoryTag")}
          </span>
        )}
        {open ? <CaretDown size={13} className="ag-chevron" /> : <CaretRight size={13} className="ag-chevron" />}
      </div>

      {open && (
        <div className="ag-body">
          {/* Tabs switch what is rendered, never what is mounted in state — the
              draft lives in this component, so moving between them mid-edit
              keeps every unsaved change. Save/Delete stay below the tabs for
              the same reason: an edit on one tab must be committable without
              hunting for the button on another. */}
          <TabList value={tab} onChange={(v) => setTab(v as EditorTab)} size="sm">
            <Tab value="basics" label={t("settings.agents.tabBasics")} />
            <Tab value="prompt" label={t("settings.agents.tabPrompt")} />
            <Tab value="rp" label={t("settings.agents.tabRp")} />
            <Tab
              value="memory"
              label={t("settings.agents.tabMemory")}
              endContent={memoryEnabled ? <span className="ag-tab-dot" /> : undefined}
            />
          </TabList>

          <div className="ag-tabpanel">
            {tab === "basics" && (
              <>
                <AgentBasics
                  name={name}
                  fallbackName={agent.name}
                  colorFrom={colorFrom}
                  colorTo={colorTo}
                  temperature={temperature}
                  model={model}
                  globalTemperature={globalTemperature}
                  availableModels={availableModels}
                  onNameChange={setName}
                  onColorFromChange={setColorFrom}
                  onColorToChange={setColorTo}
                  onTemperatureChange={setTemperature}
                  onModelChange={setModel}
                />
                <ToolPolicyPicker
                  policy={toolPolicy}
                  memoryEnabled={memoryEnabled}
                  onPolicyChange={setToolPolicy}
                  onMemoryChange={setMemoryEnabled}
                />
              </>
            )}

            {tab === "prompt" && (
              <PersonaEditor
                draft={draft}
                meta={meta}
                onPersonaChange={setPersona}
                onModeChange={setMode}
                onModulesChange={setDisabledModules}
                fetchPreview={fetchPreview}
              />
            )}

            {tab === "rp" && (
              <RpFields
                userPersona={userPersona}
                greeting={greeting}
                showPreset={!isRpShaped}
                onApplyPreset={applyRpPreset}
                onUserPersonaChange={setUserPersona}
                onGreetingChange={setGreeting}
              />
            )}

            {tab === "memory" && (
              // Keyed on the SAVED flag, not the draft one: the facts belong to
              // the agent as persisted, and a list shown before memory is
              // actually saved would offer to write into a shelf the chat route
              // won't read.
              agent.memory_enabled ? (
                <AgentMemoryList agentId={agent.id} {...memory} />
              ) : (
                <p className="ag-hint">
                  {memoryEnabled
                    ? t("settings.agents.memorySaveFirst")
                    : t("settings.agents.memoryOffHint")}
                </p>
              )
            )}
          </div>

          {saveErr && (
            <div className="st2-error" style={{ margin: "4px 0 0", position: "static" }}>{saveErr}</div>
          )}

          {confirmDelete ? (
            <div className="ag-actions ag-actions--confirm">
              <span className="ag-confirm-text">{t("settings.agents.deleteConfirm", { name: agent.name })}</span>
              <Button
                label={t("settings.agents.delete")}
                onClick={() => { void onDelete(); }}
                variant="destructive"
                size="sm"
              />
              <Button
                label={t("settings.agents.cancel")}
                onClick={() => setConfirmDelete(false)}
                variant="secondary"
                size="sm"
              />
            </div>
          ) : (
            <div className="ag-actions">
              <Button
                label={saving ? t("settings.agents.saving") : t("settings.agents.save")}
                onClick={save}
                isDisabled={saving}
                isLoading={saving}
                variant="primary"
                size="sm"
              />
              <Button
                label={t("settings.agents.delete")}
                icon={<Trash size={13} />}
                onClick={() => setConfirmDelete(true)}
                variant="destructive"
                size="sm"
                style={{ marginLeft: "auto" }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
