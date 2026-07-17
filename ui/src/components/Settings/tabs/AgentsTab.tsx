/** Agents settings tab — persona profiles (name, gradient avatar, optional
 * system-prompt override) with inline editing. Mirrors MCPTab.tsx. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Robot, Trash, CaretDown, CaretRight, Plus, X, WarningCircle } from "@phosphor-icons/react";
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
        <button className="ag-add-btn" onClick={() => setAdding(true)} disabled={loading}>
          <Plus size={14} /> {t("settings.agents.addAgent")}
        </button>
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
          <AgentAvatar colorFrom={agent.color_from} colorTo={agent.color_to} size={26} />
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
        <AgentAvatar colorFrom={agent.color_from} colorTo={agent.color_to} size={26} />
        <span className="ag-name">{agent.name}</span>
        {agent.system_prompt.trim() && (
          <span className="ag-tag ag-tag--override">{t("settings.agents.overrideTag")}</span>
        )}
        {open ? <CaretDown size={13} className="ag-chevron" /> : <CaretRight size={13} className="ag-chevron" />}
      </div>

      {open && (
        <div className="ag-body">
          <label className="ag-field">
            <span>{t("settings.agents.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="ag-field">
            <span>{t("settings.agents.avatar")}</span>
            <div className="ag-color-row">
              <AgentAvatar colorFrom={colorFrom} colorTo={colorTo} size={32} />
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

          <label className="ag-field">
            <span>{t("settings.agents.systemPrompt")}</span>
            <textarea
              rows={8}
              className="ag-prompt-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("settings.agents.systemPromptPlaceholder")}
            />
          </label>

          <div className="ag-warning">
            <WarningCircle size={15} weight="fill" />
            <span>{t("settings.agents.overrideWarning")}</span>
          </div>

          <div className="ag-prompt-actions">
            <button className="st2-btn" onClick={loadDefault} disabled={loadingDefault}>
              {loadingDefault ? "…" : t("settings.agents.loadDefault")}
            </button>
            <button className="st2-btn" onClick={() => setSystemPrompt("")} disabled={!systemPrompt}>
              {t("settings.agents.resetToDefault")}
            </button>
          </div>

          {saveErr && (
            <div className="st2-error" style={{ margin: "4px 0 0", position: "static" }}>{saveErr}</div>
          )}

          <div className="ag-actions">
            <button className="st2-btn st2-btn--primary" onClick={save} disabled={saving}>
              {saving ? t("settings.agents.saving") : t("settings.agents.save")}
            </button>
            <button className="st2-btn st2-btn--danger" style={{ marginLeft: "auto" }} onClick={onDelete}>
              <Trash size={13} /> {t("settings.agents.delete")}
            </button>
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
        <button className="ag-add-form-close" onClick={onCancel}><X size={14} /></button>
      </div>

      <div className="ag-add-grid">
        <label className="ag-field">
          <span>{t("settings.agents.name")}</span>
          <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder={t("settings.agents.namePlaceholder")} />
        </label>
        <label className="ag-field">
          <span>{t("settings.agents.id")}</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder={t("settings.agents.idPlaceholder")} />
        </label>
      </div>

      {err && <div className="st2-error" style={{ margin: "10px 0 0", position: "static" }}>{err}</div>}

      <div className="ag-actions" style={{ marginTop: 14 }}>
        <button className="st2-btn st2-btn--primary" onClick={submit} disabled={saving}>
          {saving ? t("settings.agents.adding") : t("settings.agents.add")}
        </button>
        <button className="st2-btn" onClick={onCancel} disabled={saving}>{t("settings.agents.cancel")}</button>
      </div>
    </div>
  );
}
