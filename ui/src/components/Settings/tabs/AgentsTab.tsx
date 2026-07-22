/** Agents settings tab — persona profiles (name, gradient avatar, optional
 * system-prompt override) with inline editing. Mirrors MCPTab.tsx. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Robot, Trash, CaretDown, CaretRight, Plus, X, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useAgents, type AgentPatch } from "../../../hooks/useAgents";
import { AgentAvatar } from "../../AgentAvatar";
import type { Agent } from "../../../types/agent";

const DEFAULT_AGENT_ID = "default";

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

export function AgentsTab() {
  const { t } = useTranslation();
  const { agents, loading, createAgent, updateAgent, deleteAgent, fetchDefaultPrompt } = useAgents();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const onDelete = async (agent: Agent) => {
    if (!confirm(t("settings.agents.deleteConfirm", { name: agent.name }))) return;
    await deleteAgent(agent.id);
    if (expanded === agent.id) setExpanded(null);
  };

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

      {agents.length === 0 && !loading && (
        <p className="st2-sub" style={{ color: "var(--muted)", marginTop: 0 }}>
          {t("settings.agents.empty")}
        </p>
      )}

      <div className="ag-list">
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            isDefault={a.id === DEFAULT_AGENT_ID}
            open={expanded === a.id}
            onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
            onDelete={() => onDelete(a)}
            onSave={(patch) => updateAgent(a.id, patch)}
            fetchDefaultPrompt={fetchDefaultPrompt}
          />
        ))}
      </div>

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

/* ── AgentCard ────────────────────────────────────────────────────────── */

function AgentCard({
  agent, isDefault, open, onToggle, onDelete, onSave, fetchDefaultPrompt,
}: {
  agent: Agent;
  isDefault: boolean;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSave: (patch: AgentPatch) => Promise<Agent | null>;
  fetchDefaultPrompt: () => Promise<string>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(agent.name);
  const [colorFrom, setColorFrom] = useState(agent.color_from);
  const [colorTo, setColorTo] = useState(agent.color_to);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [loadingDefault, setLoadingDefault] = useState(false);

  useEffect(() => {
    setName(agent.name);
    setColorFrom(agent.color_from);
    setColorTo(agent.color_to);
    setSystemPrompt(agent.system_prompt);
  }, [agent]);

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const result = await onSave({
        name: name.trim() || agent.name,
        color_from: colorFrom,
        color_to: colorTo,
        system_prompt: systemPrompt,
      });
      if (!result) setSaveErr(t("settings.agents.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const loadDefault = async () => {
    setLoadingDefault(true);
    try {
      const prompt = await fetchDefaultPrompt();
      if (prompt) setSystemPrompt(prompt);
    } finally {
      setLoadingDefault(false);
    }
  };

  // The default agent is fixed — no expand, no edit, no delete. It always
  // stays the safe, guaranteed-working AgentChat persona.
  if (isDefault) {
    return (
      <div className="ag-card ag-card--locked">
        <div className="ag-head ag-head--static">
          <AgentAvatar name={agent.name} colorFrom={agent.color_from} colorTo={agent.color_to} size={26} />
          <span className="ag-name">{agent.name}</span>
          <span className="ag-tag">{t("settings.agents.defaultTag")}</span>
          <span className="ag-locked-hint">{t("settings.agents.defaultLockedHint")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`ag-card${open ? " ag-card--open" : ""}`}>
      <div className="ag-head" onClick={onToggle}>
        <AgentAvatar name={agent.name} colorFrom={agent.color_from} colorTo={agent.color_to} size={26} />
        <span className="ag-name">{agent.name}</span>
        {agent.system_prompt.trim() && (
          <span className="ag-tag ag-tag--override">{t("settings.agents.overrideTag")}</span>
        )}
        {open ? <CaretDown size={13} className="ag-chevron" /> : <CaretRight size={13} className="ag-chevron" />}
      </div>

      {open && (
        <div className="ag-body">
          <TextInput
            label={t("settings.agents.name")}
            value={name}
            onChange={setName}
          />

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

          <TextArea
            label={t("settings.agents.systemPrompt")}
            value={systemPrompt}
            onChange={setSystemPrompt}
            placeholder={t("settings.agents.systemPromptPlaceholder")}
            rows={8}
          />

          <div className="ag-warning">
            <WarningCircle size={15} weight="fill" />
            <span>{t("settings.agents.overrideWarning")}</span>
          </div>

          {saveErr && (
            <div className="st2-error" style={{ margin: "4px 0 0", position: "static" }}>{saveErr}</div>
          )}

          <div className="ag-prompt-actions">
            <Button
              label={loadingDefault ? "…" : t("settings.agents.loadDefault")}
              onClick={loadDefault}
              isDisabled={loadingDefault}
              isLoading={loadingDefault}
              variant="secondary"
              size="sm"
            />
            <Button
              label={t("settings.agents.resetToDefault")}
              onClick={() => setSystemPrompt("")}
              isDisabled={!systemPrompt}
              variant="secondary"
              size="sm"
            />
          </div>

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
              onClick={onDelete}
              variant="destructive"
              size="sm"
              style={{ marginLeft: "auto" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── AddAgentForm ─────────────────────────────────────────────────────── */

function AddAgentForm({
  existingIds, onCancel, onAdded, createAgent,
}: {
  existingIds: Set<string>;
  onCancel: () => void;
  onAdded: () => void;
  createAgent: (id: string, name: string) => Promise<Agent | null>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onNameChange = (v: string) => {
    setName(v);
    setId(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  };

  const submit = async () => {
    setErr(null);
    const trimId = id.trim();
    if (!trimId || !name.trim()) { setErr(t("settings.agents.validationIdName")); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimId)) { setErr(t("settings.agents.validationIdFormat")); return; }
    if (existingIds.has(trimId)) { setErr(t("settings.agents.validationIdExists")); return; }

    setSaving(true);
    try {
      const result = await createAgent(trimId, name.trim());
      if (!result) { setErr(t("settings.agents.saveError")); return; }
      onAdded();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ag-add-form">
      <div className="ag-add-form-head">
        <span>{t("settings.agents.newAgent")}</span>
        <IconButton label={t("common.close")} icon={<X size={14} />} onClick={onCancel} variant="ghost" size="sm" />
      </div>

      <div className="ag-add-grid">
        <TextInput
          label={t("settings.agents.name")}
          value={name}
          onChange={onNameChange}
          placeholder={t("settings.agents.namePlaceholder")}
        />
        <TextInput
          label={t("settings.agents.id")}
          value={id}
          onChange={setId}
          placeholder={t("settings.agents.idPlaceholder")}
        />
      </div>

      {err && <div className="st2-error" style={{ margin: "10px 0 0", position: "static" }}>{err}</div>}

      <div className="ag-actions" style={{ marginTop: 14 }}>
        <Button
          label={saving ? t("settings.agents.adding") : t("settings.agents.add")}
          onClick={submit}
          isDisabled={saving}
          isLoading={saving}
          variant="primary"
          size="sm"
        />
        <Button
          label={t("settings.agents.cancel")}
          onClick={onCancel}
          isDisabled={saving}
          variant="secondary"
          size="sm"
        />
      </div>
    </div>
  );
}
