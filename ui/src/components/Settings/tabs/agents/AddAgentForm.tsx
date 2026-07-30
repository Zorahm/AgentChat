/** New-agent form. Name only — the id is derived, as in the Providers tab. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { Agent } from "../../../../types/agent";
import { uniqueAgentId } from "./slug";

interface AddAgentFormProps {
  existingIds: ReadonlySet<string>;
  onCancel: () => void;
  onAdded: () => void;
  createAgent: (id: string, name: string) => Promise<Agent | null>;
}

export function AddAgentForm({ existingIds, onCancel, onAdded, createAgent }: AddAgentFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const id = trimmed ? uniqueAgentId(trimmed, existingIds) : "";

  const submit = async () => {
    setErr(null);
    if (!trimmed) { setErr(t("settings.agents.validationName")); return; }
    setSaving(true);
    try {
      const result = await createAgent(id, trimmed);
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

      <TextInput
        label={t("settings.agents.name")}
        value={name}
        onChange={setName}
        placeholder={t("settings.agents.namePlaceholder")}
        hasAutoFocus
      />
      {id && <span className="st2-add-slug">id: <code>{id}</code></span>}

      {err && <div className="st2-error" style={{ margin: "10px 0 0", position: "static" }}>{err}</div>}

      <div className="ag-actions" style={{ marginTop: 14 }}>
        <Button
          label={saving ? t("settings.agents.adding") : t("settings.agents.add")}
          onClick={submit}
          isDisabled={saving || !trimmed}
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
