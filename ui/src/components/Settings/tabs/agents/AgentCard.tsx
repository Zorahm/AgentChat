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
import { TextInput } from "@astryxdesign/core/TextInput";
import { AgentAvatar } from "../../../AgentAvatar";
import type { AgentDraft, AgentPatch } from "../../../../hooks/useAgents";
import type { Agent, AgentEditorMeta, AgentPreview, PromptMode } from "../../../../types/agent";
import { PersonaEditor } from "./PersonaEditor";

const GRADIENT_SWATCHES: Array<[string, string]> = [
  ["#7c6fdc", "#4f9dde"],
  ["#f2709c", "#ff9472"],
  ["#43e97b", "#38f9d7"],
  ["#fa709a", "#fee140"],
  ["#30cfd0", "#7b2ff7"],
  ["#a18cd1", "#fbc2eb"],
  ["#ff9a9e", "#fecfef"],
  ["#f6d365", "#fda085"],
];

interface AgentCardProps {
  agent: Agent;
  open: boolean;
  meta: AgentEditorMeta;
  onToggle: () => void;
  onDelete: () => Promise<void>;
  onSave: (patch: AgentPatch) => Promise<Agent | null>;
  fetchPreview: (draft: AgentDraft) => Promise<AgentPreview | null>;
}

export function AgentCard({
  agent, open, meta, onToggle, onDelete, onSave, fetchPreview,
}: AgentCardProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(agent.name);
  const [colorFrom, setColorFrom] = useState(agent.color_from);
  const [colorTo, setColorTo] = useState(agent.color_to);
  const [persona, setPersona] = useState(agent.system_prompt);
  const [mode, setMode] = useState<PromptMode>(agent.prompt_mode);
  const [disabledModules, setDisabledModules] = useState<string[]>(agent.disabled_modules);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const draft: AgentDraft = {
    name,
    system_prompt: persona,
    prompt_mode: mode,
    disabled_modules: disabledModules,
  };

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
        {open ? <CaretDown size={13} className="ag-chevron" /> : <CaretRight size={13} className="ag-chevron" />}
      </div>

      {open && (
        <div className="ag-body">
          <TextInput label={t("settings.agents.name")} value={name} onChange={setName} />

          <div className="ag-field">
            <span>{t("settings.agents.avatar")}</span>
            <div className="ag-color-row">
              <AgentAvatar name={name || agent.name} colorFrom={colorFrom} colorTo={colorTo} size={32} />
              <input type="color" value={colorFrom} onChange={(e) => setColorFrom(e.target.value)} title={t("settings.agents.colorFrom")} />
              <input type="color" value={colorTo} onChange={(e) => setColorTo(e.target.value)} title={t("settings.agents.colorTo")} />
              <div className="ag-swatches">
                {GRADIENT_SWATCHES.map(([from, to]) => (
                  <button
                    key={`${from}-${to}`}
                    className="ag-swatch"
                    style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
                    onClick={() => { setColorFrom(from); setColorTo(to); }}
                    title={`${from} → ${to}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <PersonaEditor
            draft={draft}
            meta={meta}
            onPersonaChange={setPersona}
            onModeChange={setMode}
            onModulesChange={setDisabledModules}
            fetchPreview={fetchPreview}
          />

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
