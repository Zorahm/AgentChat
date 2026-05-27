import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderConfig, ModelConfig, SettingsData } from "../SettingsPanel";

/* ── Types ─────────────────────── */

interface ProviderStatus { id: string; status: string; count: number; error: string | null }

/* ── Logo map ──────────────────── */

const LOGO: Record<string, string> = {
  openai: "lg-openai", anthropic: "lg-anthropic", gemini: "lg-google",
  deepseek: "lg-deepseek", groq: "lg-groq", mistral: "lg-mistral",
  cohere: "lg-cohere", together: "lg-together", openrouter: "lg-openrouter",
  lmstudio: "lg-lmstudio", litellm_proxy: "lg-proxy",
  opencode: "lg-opencode",
};

/* ── ProvidersTab ──────────────── */

export function ProvidersTab({ settings, statuses, loading, expanded, setExpanded, onUpdate, onAdd, onDelete, onRefreshModels }: {
  settings: SettingsData;
  statuses: ProviderStatus[];
  loading: boolean;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  onUpdate: (id: string, p: Record<string, unknown>) => Promise<boolean | undefined>;
  onAdd: (body: { id: string; name: string; api_base: string; api_key?: string }) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRefreshModels: () => void;
}) {
  const { t } = useTranslation();
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">{t("settings.providers.title")}</h3>
        <p className="st2-sub">{t("settings.providers.description")}</p>
      </div>
      <button className="st2-btn" onClick={onRefreshModels} disabled={loading}>
        {loading ? t("settings.providers.refresh") : t("settings.providers.refresh")}
      </button>
    </div>
    {settings.providers.map((p) => (
      <ProviderCard key={p.id} p={p}
        models={settings.models.filter((m) => m.id.startsWith(p.id + "/"))}
        status={statusMap.get(p.id)}
        defaultModel={settings.default_model} open={expanded === p.id}
        onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
        onUpdate={(x) => onUpdate(p.id, x)}
        onDelete={p.custom ? () => onDelete(p.id) : undefined} />
    ))}
    <AddProviderForm existingIds={new Set(settings.providers.map((p) => p.id))} onAdd={onAdd} />
  </>;
}

/* ── Add provider form ─────────── */

function AddProviderForm({ existingIds, onAdd }: {
  existingIds: Set<string>;
  onAdd: (body: { id: string; name: string; api_base: string; api_key?: string }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => { setId(""); setName(""); setBase(""); setKey(""); setErr(null); };

  const submit = async () => {
    setErr(null);
    const trimmedId = id.trim().toLowerCase();
    if (!trimmedId || !name.trim() || !base.trim()) {
      setErr(t("settings.providers.validationRequired"));
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(trimmedId)) {
      setErr(t("settings.providers.validationFormat"));
      return;
    }
    if (existingIds.has(trimmedId)) {
      setErr(t("settings.providers.validationExists", { id: trimmedId }));
      return;
    }
    setSaving(true);
    const ok = await onAdd({ id: trimmedId, name: name.trim(), api_base: base.trim(), api_key: key.trim() || undefined });
    setSaving(false);
    if (ok) { reset(); setOpen(false); }
    else setErr(t("settings.providers.saveError"));
  };

  if (!open) {
    return (
      <button className="st2-add-btn" onClick={() => setOpen(true)}>
        + {t("settings.providers.addButton")}
      </button>
    );
  }

  return (
    <div className="st2-add-form">
      <h4>{t("settings.providers.formTitle")}</h4>
      <p className="st2-sub2">{t("settings.providers.formDescription")}</p>
      <div className="st2-add-grid">
        <label>{t("settings.providers.id")}
          <input className="st2-field" placeholder={t("settings.providers.idPlaceholder")} value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label>{t("settings.providers.name")}
          <input className="st2-field" placeholder={t("settings.providers.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>{t("settings.providers.apiBase")}
          <input className="st2-field" placeholder={t("settings.providers.apiBasePlaceholder")} value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>{t("settings.providers.apiKey")}
          <input type="password" className="st2-field" placeholder={t("settings.providers.apiKeyOptional")} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
      </div>
      {err && <div className="st2-add-err">{err}</div>}
      <div className="st2-add-actions">
        <button className="st2-btn" onClick={submit} disabled={saving}>{saving ? t("settings.providers.saving") : t("settings.providers.add")}</button>
        <button className="st2-btn st2-btn--ghost" onClick={() => { reset(); setOpen(false); }}>{t("settings.providers.cancel")}</button>
      </div>
    </div>
  );
}

/* ── Provider card ─────────────── */

function ProviderCard({ p, models, status, defaultModel, open, onToggle, onUpdate, onDelete }: {
  p: ProviderConfig; models: ModelConfig[]; status?: ProviderStatus;
  defaultModel: string;
  open: boolean; onToggle: () => void;
  onUpdate: (patch: Record<string, unknown>) => Promise<boolean | undefined>;
  onDelete?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const logo = p.name[0]?.toUpperCase() ?? "?";

  const handleSaveKey = async () => {
    if (!key.trim()) return;
    const ok = await onUpdate({ api_key: key.trim() });
    if (ok) setKey("");
  };

  const badge = status?.status === "error"
    ? <span className="st2-pv-badge err" title={status.error ?? ""}>{t("settings.providers.error")}</span>
    : status?.status === "ok"
    ? <span className="st2-pv-badge ok">{t("settings.providers.modelsCount", { count: status.count })}</span>
    : null;

  return (
    <div className="st2-provider">
      <div className="st2-pv-head" onClick={onToggle}>
        <div className={`st2-pv-logo ${LOGO[p.id] ?? "lg-other"}`}>{logo}</div>
        <div className="st2-pv-name">{p.name}<small>{p.api_base ?? "—"}</small></div>
        {badge}
        <div className="st2-pv-key">{p.api_key_set ? "••••" : t("settings.providers.noKey")}</div>
        <div className={`st2-switch${p.enabled ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !p.enabled }); }} />
      </div>
      {open && (
        <div className="st2-pv-body">
          {status?.status === "error" && (
            <div className="st2-pv-err">{t("settings.providers.modelsError", { error: status.error })}</div>
          )}
          {models.length === 0 && status?.status !== "error" && (
            <div className="st2-pv-empty">{p.api_key_set ? t("settings.providers.modelsEmpty") : t("settings.providers.modelsEmptyHint")}</div>
          )}
          {models.map((m) => (
            <div key={m.id} className="st2-pv-row">
              <span className="st2-pv-model">{m.name ?? m.id}</span>
              {m.thinking && <span className="st2-think-tag">{t("settings.providers.thinking")}</span>}
              <div className={`st2-switch${m.id === defaultModel ? " on" : ""}`} />
            </div>
          ))}
          <div className="st2-pv-key-row">
            <input type="password" className="st2-field"
              placeholder={p.api_key_set ? t("settings.providers.keyNew") : t("settings.providers.keyPlaceholder")}
              value={key} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveKey()} />
            <button className="st2-btn" onClick={handleSaveKey}>
              {t("settings.providers.saveKey")}
            </button>
            {onDelete && (
              <button className="st2-btn st2-btn--danger" onClick={onDelete}>
                {t("settings.providers.delete")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
