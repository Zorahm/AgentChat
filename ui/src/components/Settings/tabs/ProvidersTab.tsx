import { useState } from "react";
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
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">Провайдеры</h3>
        <p className="st2-sub">Модели подгружаются с {`{api_base}/models`} каждого провайдера.</p>
      </div>
      <button className="st2-btn" onClick={onRefreshModels} disabled={loading}>
        {loading ? "Обновляю…" : "Обновить модели"}
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
      setErr("ID, название и api_base обязательны");
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(trimmedId)) {
      setErr("ID: только латиница, цифры, _ и -");
      return;
    }
    if (existingIds.has(trimmedId)) {
      setErr(`Провайдер '${trimmedId}' уже существует`);
      return;
    }
    setSaving(true);
    const ok = await onAdd({ id: trimmedId, name: name.trim(), api_base: base.trim(), api_key: key.trim() || undefined });
    setSaving(false);
    if (ok) { reset(); setOpen(false); }
    else setErr("Не удалось сохранить");
  };

  if (!open) {
    return (
      <button className="st2-add-btn" onClick={() => setOpen(true)}>
        + Добавить OpenAI-совместимого провайдера
      </button>
    );
  }

  return (
    <div className="st2-add-form">
      <h4>Свой провайдер (OpenAI-совместимый)</h4>
      <p className="st2-sub2">Должен поддерживать <code>{`{api_base}/models`}</code> и <code>{`{api_base}/chat/completions`}</code>.</p>
      <div className="st2-add-grid">
        <label>ID
          <input className="st2-field" placeholder="my-provider" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label>Название
          <input className="st2-field" placeholder="My Provider" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>API Base
          <input className="st2-field" placeholder="https://api.example.com/v1" value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>API Key
          <input type="password" className="st2-field" placeholder="(опционально)" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
      </div>
      {err && <div className="st2-add-err">{err}</div>}
      <div className="st2-add-actions">
        <button className="st2-btn" onClick={submit} disabled={saving}>{saving ? "Сохраняю…" : "Добавить"}</button>
        <button className="st2-btn st2-btn--ghost" onClick={() => { reset(); setOpen(false); }}>Отмена</button>
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
  const [key, setKey] = useState("");
  const logo = p.name[0]?.toUpperCase() ?? "?";

  const handleSaveKey = async () => {
    if (!key.trim()) return;
    const ok = await onUpdate({ api_key: key.trim() });
    if (ok) setKey("");
  };

  const badge = status?.status === "error"
    ? <span className="st2-pv-badge err" title={status.error ?? ""}>ошибка</span>
    : status?.status === "ok"
    ? <span className="st2-pv-badge ok">{status.count} моделей</span>
    : null;

  return (
    <div className="st2-provider">
      <div className="st2-pv-head" onClick={onToggle}>
        <div className={`st2-pv-logo ${LOGO[p.id] ?? "lg-other"}`}>{logo}</div>
        <div className="st2-pv-name">{p.name}<small>{p.api_base ?? "—"}</small></div>
        {badge}
        <div className="st2-pv-key">{p.api_key_set ? "••••" : "без ключа"}</div>
        <div className={`st2-switch${p.enabled ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !p.enabled }); }} />
      </div>
      {open && (
        <div className="st2-pv-body">
          {status?.status === "error" && (
            <div className="st2-pv-err">Не удалось получить список моделей: {status.error}</div>
          )}
          {models.length === 0 && status?.status !== "error" && (
            <div className="st2-pv-empty">Моделей нет.{p.api_key_set ? "" : " Добавь ключ и обнови список."}</div>
          )}
          {models.map((m) => (
            <div key={m.id} className="st2-pv-row">
              <span className="st2-pv-model">{m.name ?? m.id}</span>
              {m.thinking && <span className="st2-think-tag">thinking</span>}
              <div className={`st2-switch${m.id === defaultModel ? " on" : ""}`} />
            </div>
          ))}
          <div className="st2-pv-key-row">
            <input type="password" className="st2-field"
              placeholder={p.api_key_set ? "•••• (установить новый)" : "API ключ…"}
              value={key} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveKey()} />
            <button className="st2-btn" onClick={handleSaveKey}>
              Сохранить
            </button>
            {onDelete && (
              <button className="st2-btn st2-btn--danger" onClick={onDelete}>
                Удалить
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
