import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderConfig, ModelConfig, SettingsData } from "../SettingsPanel";
import { API_BASE } from "../../../utils/apiBase";

/* ── Types ─────────────────────────────────────────── */

interface ProviderStatus { id: string; status: string; count: number; error: string | null }
interface HeaderRow { key: string; value: string }

/* ── Logo map ──────────────────────────────────────── */

const LOGO: Record<string, string> = {
  openai: "lg-openai", anthropic: "lg-anthropic", gemini: "lg-google",
  deepseek: "lg-deepseek", groq: "lg-groq", mistral: "lg-mistral",
  cohere: "lg-cohere", together: "lg-together", openrouter: "lg-openrouter",
  lmstudio: "lg-lmstudio", litellm_proxy: "lg-proxy",
  opencode: "lg-opencode", yandex: "lg-yandex",
};

const RU_PROVIDERS = new Set(["yandex"]);

/* ── Helpers ───────────────────────────────────────── */

function headersToRows(h: Record<string, string> | null | undefined): HeaderRow[] {
  return h ? Object.entries(h).map(([key, value]) => ({ key, value })) : [];
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | null {
  const valid = rows.filter((r) => r.key.trim());
  return valid.length > 0 ? Object.fromEntries(valid.map((r) => [r.key.trim(), r.value])) : null;
}

/* ── Friendly fetch error ──────────────────────────── */

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function friendlyFetchError(raw: string | null | undefined, providerId: string, t: TFn): string {
  if (!raw) return t("settings.providers.errUnknown");
  if (raw === "api_key not set") return t("settings.providers.errNoKey");
  if (raw === "api_base not configured") return t("settings.providers.errNoBase");
  if (/connect|timeout|network/i.test(raw)) return t("settings.providers.errConnect");

  const m = raw.match(/^HTTP (\d{3})$/);
  if (m) {
    const code = Number(m[1]);
    if (code === 401) return t("settings.providers.errHttp401");
    if (code === 403) {
      return t(
        providerId === "yandex"
          ? "settings.providers.errHttp403Yandex"
          : "settings.providers.errHttp403"
      );
    }
    if (code === 404) return t("settings.providers.errHttp404");
    if (code === 429) return t("settings.providers.errHttp429");
    if (code >= 500) return t("settings.providers.errHttp5xx", { code });
  }

  return raw;
}

/* ── KV headers editor ─────────────────────────────── */

function HeadersEditor({ rows, onChange, lockedKeys }: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  lockedKeys?: Set<string>;
}) {
  const { t } = useTranslation();
  const update = (i: number, field: "key" | "value", val: string) => {
    onChange(rows.map((r, j) => j === i ? { ...r, [field]: val } : r));
  };
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, { key: "", value: "" }]);

  return (
    <div className="mcp-kv">
      {rows.map((r, i) => {
        const locked = lockedKeys?.has(r.key) ?? false;
        return (
          <div key={i} className="mcp-kv-row">
            {locked ? (
              <span className="mcp-kv-key-locked"><code>{r.key}</code></span>
            ) : (
              <input
                className="mcp-kv-key"
                placeholder={t("settings.providers.headerName")}
                value={r.key}
                onChange={(e) => update(i, "key", e.target.value)}
              />
            )}
            <span className="mcp-kv-eq">=</span>
            <input
              className="mcp-kv-val"
              placeholder={t("settings.providers.headerValue")}
              value={r.value}
              onChange={(e) => update(i, "value", e.target.value)}
            />
            {!locked && (
              <button className="mcp-kv-del" onClick={() => remove(i)} title={t("settings.providers.removeHeader")}>
                ×
              </button>
            )}
          </div>
        );
      })}
      <button className="mcp-kv-add" onClick={add}>
        + {t("settings.providers.addHeader")}
      </button>
    </div>
  );
}

/* ── ProvidersTab ──────────────────────────────────── */

export function ProvidersTab({ settings, statuses, loading, expanded, setExpanded, onUpdate, onAdd, onDelete, onRefreshModels, onUpdateGlobal }: {
  settings: SettingsData;
  statuses: ProviderStatus[];
  loading: boolean;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  onUpdate: (id: string, p: Record<string, unknown>) => Promise<boolean | undefined>;
  onAdd: (body: { id: string; name: string; api_base: string; api_key?: string; extra_headers?: Record<string, string> }) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRefreshModels: () => void;
  onUpdateGlobal: (p: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const statusMap = new Map(statuses.map((s) => [s.id, s]));

  const globalProviders = settings.providers.filter((p) => !RU_PROVIDERS.has(p.id));
  const ruProviders = settings.providers.filter((p) => RU_PROVIDERS.has(p.id));

  const renderCard = (p: ProviderConfig) => (
    <ProviderCard key={p.id} p={p}
      models={settings.models.filter((m) => m.id.startsWith(p.id + "/"))}
      status={statusMap.get(p.id)}
      defaultModel={settings.default_model}
      open={expanded === p.id}
      onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
      onUpdate={(x) => onUpdate(p.id, x)}
      onSetDefault={(modelId) => onUpdateGlobal({ default_model: modelId })}
      onDelete={p.custom ? () => onDelete(p.id) : undefined}
    />
  );

  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">{t("settings.providers.title")}</h3>
        <p className="st2-sub">{t("settings.providers.description")}</p>
      </div>
      <button className="st2-btn" onClick={onRefreshModels} disabled={loading}>
        {t("settings.providers.refresh")}
      </button>
    </div>

    <div className="st2-pv-section-label">{t("settings.providers.globalSection")}</div>
    {globalProviders.map(renderCard)}

    {ruProviders.length > 0 && <>
      <div className="st2-pv-section-label" style={{ marginTop: 20 }}>
        {t("settings.providers.ruSection")}
      </div>
      {ruProviders.map(renderCard)}
    </>}

    <AddProviderForm existingIds={new Set(settings.providers.map((p) => p.id))} onAdd={onAdd} />

    <WebSearchSettings settings={settings} onUpdate={onUpdateGlobal} />
  </>;
}

/* ── Web search settings ───────────────────────────── */

interface WsModeStatus { id: string; available: boolean; reason: string }

function WebSearchSettings({ settings, onUpdate }: {
  settings: SettingsData;
  onUpdate: (p: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [modes, setModes] = useState<WsModeStatus[]>([]);
  const [searxng, setSearxng] = useState(settings.searxng_url ?? "");
  const [tavily, setTavily] = useState("");

  useEffect(() => { setSearxng(settings.searxng_url ?? ""); }, [settings.searxng_url]);

  const reloadModes = () => {
    fetch(`${API_BASE}/config/web-search`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { modes?: WsModeStatus[] } | null) => { if (d?.modes) setModes(d.modes); })
      .catch(() => {});
  };
  useEffect(reloadModes, []);

  const mode = settings.web_search_mode ?? "auto";
  const statusOf = (id: string) => modes.find((m) => m.id === id);

  const commitSearxng = () => {
    const next = searxng.trim();
    if (next !== (settings.searxng_url ?? "")) onUpdate({ searxng_url: next });
    setTimeout(reloadModes, 300);
  };

  const commitTavily = () => {
    if (!tavily.trim()) return;
    onUpdate({ tavily_api_key: tavily.trim() });
    setTavily("");
    setTimeout(reloadModes, 300);
  };

  const MODES: { id: string; labelKey: string }[] = [
    { id: "auto", labelKey: "chat.webSearch.modes.auto" },
    { id: "native", labelKey: "chat.webSearch.modes.native" },
    { id: "litellm", labelKey: "chat.webSearch.modes.litellm" },
    { id: "searxng", labelKey: "chat.webSearch.modes.searxng" },
  ];

  return (
    <div className="st2-ws">
      <div className="st2-pv-section-label" style={{ marginTop: 22 }}>
        {t("settings.providers.webSearch.title")}
      </div>
      <p className="st2-sub">{t("settings.providers.webSearch.description")}</p>

      <div className="st2-ws-list">
        {MODES.map((m) => {
          const st = statusOf(m.id);
          const selected = mode === m.id;
          const hasStatus = m.id !== "auto";
          const available = !hasStatus || !st || st.available;
          return (
            <div key={m.id} className={`st2-ws-item${selected ? " selected" : ""}`}>
              <button
                type="button"
                className="st2-ws-item-head"
                onClick={() => onUpdate({ web_search_mode: m.id })}
              >
                <span className="st2-ws-radio" aria-hidden />
                <span className="st2-ws-item-info">
                  <span className="st2-ws-item-name">
                    {t(m.labelKey)}
                    {hasStatus && (
                      <span
                        className={`st2-ws-status${available ? " ok" : " off"}`}
                        title={st?.reason ?? ""}
                      >
                        {available
                          ? t("settings.providers.webSearch.ready")
                          : t("settings.providers.webSearch.unavailable")}
                      </span>
                    )}
                  </span>
                  <span className="st2-ws-item-desc">
                    {t(`settings.providers.webSearch.modeDesc.${m.id}`)}
                  </span>
                </span>
              </button>

              {selected && m.id === "litellm" && (
                <div className="st2-ws-config">
                  <label className="st2-ws-config-label">
                    {t("settings.providers.webSearch.tavilyLabel")}
                    {settings.tavily_api_key_set && (
                      <span className="st2-ws-ok">✓ {t("settings.providers.webSearch.configured")}</span>
                    )}
                  </label>
                  <div className="st2-ws-keyrow">
                    <input
                      type="password"
                      value={tavily}
                      placeholder={settings.tavily_api_key_set ? "••••••••••••" : "tvly-..."}
                      onChange={(e) => setTavily(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") commitTavily(); }}
                    />
                    <button className="st2-btn" onClick={commitTavily} disabled={!tavily.trim()}>
                      {t("common.save")}
                    </button>
                  </div>
                  <p className="st2-ws-hint">{t("settings.providers.webSearch.tavilyHint")}</p>
                </div>
              )}

              {selected && m.id === "searxng" && (
                <div className="st2-ws-config">
                  <label className="st2-ws-config-label">
                    {t("settings.providers.webSearch.searxngLabel")}
                  </label>
                  <input
                    type="text"
                    value={searxng}
                    placeholder="http://localhost:8080"
                    onChange={(e) => setSearxng(e.target.value)}
                    onBlur={commitSearxng}
                  />
                  <p className="st2-ws-hint">{t("settings.providers.webSearch.searxngHint")}</p>
                  <SearxngInstaller
                    onInstalled={(url) => { onUpdate({ searxng_url: url }); setTimeout(reloadModes, 400); }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SearxngStatusDTO {
  wsl_available: boolean;
  docker_available: boolean;
  docker_cli: boolean;
  docker_desktop_installed: boolean;
  winget_available: boolean;
  docker_download_url: string;
  running: boolean;
  url: string | null;
  installing: boolean;
  installing_docker: boolean;
}

const WS = "settings.providers.webSearch";

function SearxngInstaller({ onInstalled }: { onInstalled: (url: string) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SearxngStatusDTO | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dockerLog, setDockerLog] = useState("");
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [dockerBusy, setDockerBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairResult, setRepairResult] = useState<{ ok: boolean; message: string } | null>(null);
  const notifiedRef = useRef(false);

  const refreshStatus = () => {
    fetch(`${API_BASE}/searxng/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SearxngStatusDTO | null) => { if (d) setStatus(d); })
      .catch(() => {});
  };
  useEffect(refreshStatus, []);

  const poll = () => {
    const tick = () => {
      fetch(`${API_BASE}/searxng/install/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { running: boolean; log: string; error: string | null; url: string | null } | null) => {
          if (!d) return;
          setLog(d.log);
          setError(d.error);
          if (d.running) {
            setTimeout(tick, 1500);
          } else {
            setBusy(false);
            refreshStatus();
            if (d.url && !d.error && !notifiedRef.current) {
              notifiedRef.current = true;
              onInstalled(d.url);
            }
          }
        })
        .catch(() => setBusy(false));
    };
    tick();
  };

  const install = () => {
    setBusy(true);
    setError(null);
    setLog("");
    notifiedRef.current = false;
    fetch(`${API_BASE}/searxng/install`, { method: "POST" })
      .then(() => poll())
      .catch(() => setBusy(false));
  };

  const pollDocker = () => {
    const tick = () => {
      fetch(`${API_BASE}/searxng/install-docker/status`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { running: boolean; log: string; error: string | null; docker_available: boolean } | null) => {
          if (!d) return;
          setDockerLog(d.log);
          setDockerError(d.error);
          if (d.running) {
            setTimeout(tick, 2000);
          } else {
            setDockerBusy(false);
            // refreshStatus flips docker_desktop_installed → the primary button
            // becomes "Install SearXNG" for the user to click next.
            refreshStatus();
          }
        })
        .catch(() => setDockerBusy(false));
    };
    tick();
  };

  const installDocker = () => {
    setDockerBusy(true);
    setDockerError(null);
    setDockerLog("");
    fetch(`${API_BASE}/searxng/install-docker`, { method: "POST" })
      .then(() => pollDocker())
      .catch(() => setDockerBusy(false));
  };

  // Re-apply settings.yml into an already-running container. Useful when
  // /search?format=json returns 403 because Docker Desktop + WSL2 silently
  // dropped our bind-mounted config.
  const repair = () => {
    setRepairBusy(true);
    setRepairResult(null);
    fetch(`${API_BASE}/searxng/repair`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { success: boolean; output: string }) => {
        setRepairResult({ ok: d.success, message: d.output });
        refreshStatus();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setRepairResult({ ok: false, message });
      })
      .finally(() => setRepairBusy(false));
  };

  if (!status) return null;

  return (
    <div className="st2-ws-install">
      <div className="st2-ws-install-head">
        <span className="st2-ws-install-title">{t(`${WS}.installTitle`)}</span>
        {status.running && <span className="st2-ws-ok">● {t(`${WS}.running`)}</span>}
      </div>

      {!status.wsl_available ? (
        <p className="st2-ws-hint">{t(`${WS}.needWsl`)}</p>
      ) : !status.docker_desktop_installed ? (
        // Step 1 — Docker isn't installed yet. Download it (winget) or guide.
        status.winget_available ? (
          <>
            <p className="st2-ws-hint">{t(`${WS}.dockerAutoHint`)}</p>
            <button className="st2-btn" onClick={installDocker} disabled={dockerBusy}>
              {dockerBusy ? t(`${WS}.installingDocker`) : t(`${WS}.installDocker`)}
            </button>
          </>
        ) : (
          <p className="st2-ws-hint">
            {t(`${WS}.dockerManualHint`)}{" "}
            <a href={status.docker_download_url} target="_blank" rel="noreferrer">
              {status.docker_download_url}
            </a>
          </p>
        )
      ) : (
        // Step 2 — Docker is installed. Offer the SearXNG install directly.
        <>
          <p className="st2-ws-hint">
            {status.docker_available ? t(`${WS}.installHint`) : t(`${WS}.dockerSetupHint`)}
          </p>
          <div className="st2-ws-btn-row">
            <button className="st2-btn" onClick={install} disabled={busy || repairBusy}>
              {busy
                ? t(`${WS}.installing`)
                : status.running
                  ? t(`${WS}.reinstall`)
                  : t(`${WS}.install`)}
            </button>
            {status.running && (
              <button
                className="st2-btn st2-btn-secondary"
                onClick={repair}
                disabled={busy || repairBusy}
                title={t(`${WS}.repairHint`)}
              >
                {repairBusy ? t(`${WS}.repairing`) : t(`${WS}.repair`)}
              </button>
            )}
          </div>
          {status.running && (
            <p className="st2-ws-hint st2-ws-hint-sub">{t(`${WS}.repairHint`)}</p>
          )}
        </>
      )}

      {(dockerLog || dockerError) && (
        <pre className={`st2-ws-log${dockerError ? " err" : ""}`}>
          {dockerError ? `${dockerLog}\n${dockerError}` : dockerLog}
        </pre>
      )}

      {(log || error) && (
        <pre className={`st2-ws-log${error ? " err" : ""}`}>{error ? `${log}\n${error}` : log}</pre>
      )}

      {repairResult && (
        <pre className={`st2-ws-log${repairResult.ok ? "" : " err"}`}>{repairResult.message}</pre>
      )}
    </div>
  );
}

/* ── slugify helper ────────────────────────────────── */

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/* ── Add provider form ─────────────────────────────── */

function AddProviderForm({ existingIds, onAdd }: {
  existingIds: Set<string>;
  onAdd: (body: { id: string; name: string; api_base: string; api_key?: string; extra_headers?: Record<string, string> }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = toSlug(name);
  const slugConflict = slug && existingIds.has(slug);

  const reset = () => { setName(""); setBase(""); setKey(""); setHeaderRows([]); setErr(null); };

  const submit = async () => {
    setErr(null);
    if (!name.trim() || !base.trim()) { setErr(t("settings.providers.validationRequired")); return; }
    if (!slug) { setErr(t("settings.providers.validationFormat")); return; }
    if (slugConflict) { setErr(t("settings.providers.validationExists", { id: slug })); return; }
    setSaving(true);
    const headers = rowsToHeaders(headerRows);
    const ok = await onAdd({
      id: slug,
      name: name.trim(),
      api_base: base.trim(),
      api_key: key.trim() || undefined,
      ...(headers ? { extra_headers: headers } : {}),
    });
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
      <div className="st2-add-form-head">
        <span>{t("settings.providers.formTitle")}</span>
        <button className="st2-add-form-close" onClick={() => { reset(); setOpen(false); }}>✕</button>
      </div>

      <div className="st2-add-fields">
        <label className="st2-add-label">
          {t("settings.providers.name")}
          <div className="st2-add-name-wrap">
            <input
              className="st2-field"
              placeholder={t("settings.providers.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {slug && (
              <span className={`st2-add-slug${slugConflict ? " conflict" : ""}`}>
                id: <code>{slug}</code>
              </span>
            )}
          </div>
        </label>

        <label className="st2-add-label">
          {t("settings.providers.apiBase")}
          <input
            className="st2-field"
            placeholder={t("settings.providers.apiBasePlaceholder")}
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </label>

        <label className="st2-add-label">
          {t("settings.providers.apiKey")}{" "}
          <span style={{ color: "var(--faint)", fontWeight: 400 }}>
            ({t("settings.providers.apiKeyOptional")})
          </span>
          <input
            type="password"
            className="st2-field"
            placeholder="sk-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>

        <div className="st2-add-label">
          {t("settings.providers.customHeaders")}{" "}
          <span style={{ color: "var(--faint)", fontWeight: 400 }}>
            ({t("settings.providers.apiKeyOptional")})
          </span>
          <div style={{ marginTop: 6 }}>
            <HeadersEditor rows={headerRows} onChange={setHeaderRows} />
          </div>
        </div>
      </div>

      {err && <div className="st2-add-err">{err}</div>}

      <div className="st2-add-actions">
        <button className="st2-btn" onClick={submit} disabled={saving || !slug || !!slugConflict}>
          {saving ? t("settings.providers.saving") : t("settings.providers.add")}
        </button>
        <button className="st2-btn st2-btn--ghost" onClick={() => { reset(); setOpen(false); }}>
          {t("settings.providers.cancel")}
        </button>
      </div>
    </div>
  );
}

/* ── Provider card ─────────────────────────────────── */

function ProviderCard({ p, models, status, defaultModel, open, onToggle, onUpdate, onSetDefault, onDelete }: {
  p: ProviderConfig; models: ModelConfig[]; status?: ProviderStatus;
  defaultModel: string;
  open: boolean; onToggle: () => void;
  onUpdate: (patch: Record<string, unknown>) => Promise<boolean | undefined>;
  onSetDefault: (modelId: string) => void;
  onDelete?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [headersSaving, setHeadersSaving] = useState(false);
  const logo = p.name[0]?.toUpperCase() ?? "?";

  useEffect(() => {
    if (open) {
      const rows = headersToRows(p.extra_headers);
      if (p.id === "yandex" && !rows.some((r) => r.key === "x-folder-id")) {
        rows.unshift({ key: "x-folder-id", value: "" });
      }
      setHeaderRows(rows);
    }
  }, [open]);

  const handleSaveKey = async () => {
    if (!key.trim()) return;
    const ok = await onUpdate({ api_key: key.trim() });
    if (ok) setKey("");
  };

  const handleSaveHeaders = async () => {
    setHeadersSaving(true);
    await onUpdate({ extra_headers: rowsToHeaders(headerRows) ?? {} });
    setHeadersSaving(false);
  };

  const badge = status?.status === "error"
    ? <span className="st2-pv-badge err" title={friendlyFetchError(status.error, p.id, t)}>{t("settings.providers.error")}</span>
    : status?.status === "ok"
    ? <span className="st2-pv-badge ok">{t("settings.providers.modelsCount", { count: status.count })}</span>
    : null;

  return (
    <div className={`st2-provider${p.enabled ? "" : " is-off"}${open ? " is-open" : ""}`}>
      <div className="st2-pv-head" onClick={onToggle}>
        <div className={`st2-pv-logo ${LOGO[p.id] ?? "lg-other"}`}>{logo}</div>
        <div className="st2-pv-name">{p.name}<small>{p.api_base ?? "—"}</small></div>
        <div className="st2-pv-meta">
          {badge}
          <span className="st2-pv-key">{p.api_key_set ? t("settings.providers.keySet") : t("settings.providers.noKey")}</span>
          <div
            className={`st2-switch st2-switch--lg${p.enabled ? " on" : ""}`}
            role="switch"
            aria-checked={p.enabled}
            title={p.enabled ? t("settings.providers.enabled") : t("settings.providers.disabled")}
            onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !p.enabled }); }}
          />
          <span className="st2-pv-chev" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </div>
      </div>
      {open && (
        <div className="st2-pv-body">
          {status?.status === "error" && (
            <div className="st2-pv-err">{friendlyFetchError(status.error, p.id, t)}</div>
          )}
          {models.length === 0 && status?.status !== "error" && (
            <div className="st2-pv-empty">{p.api_key_set ? t("settings.providers.modelsEmpty") : t("settings.providers.modelsEmptyHint")}</div>
          )}
          {models.map((m) => {
            const isDefault = m.id === defaultModel;
            return (
              <div
                key={m.id}
                className={`st2-pv-row${isDefault ? " is-default" : ""}`}
                role="button"
                tabIndex={0}
                title={isDefault ? t("settings.providers.defaultModel") : t("settings.providers.setDefault")}
                onClick={() => { if (!isDefault) onSetDefault(m.id); }}
                onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !isDefault) { e.preventDefault(); onSetDefault(m.id); } }}
              >
                <span className="st2-pv-model">{m.name ?? m.id}</span>
                {m.thinking && <span className="st2-think-tag">{t("settings.providers.thinking")}</span>}
                {isDefault && <span className="st2-pv-default-tag">{t("settings.providers.defaultTag")}</span>}
                <span className={`st2-pv-radio${isDefault ? " on" : ""}`} aria-hidden />
              </div>
            );
          })}
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

          {p.id === "yandex" && (
            <div className="st2-pv-setup">
              <div className="st2-pv-setup-title">{t("settings.providers.yandexSetupTitle")}</div>
              <ol className="st2-pv-setup-steps">
                <li>
                  <span dangerouslySetInnerHTML={{ __html: t("settings.providers.yandexSetupStep1") }} />
                  <code className="st2-pv-setup-url">{t("settings.providers.yandexSetupStep1Url")}</code>
                </li>
                <li dangerouslySetInnerHTML={{ __html: t("settings.providers.yandexSetupStep2") }} />
                <li>
                  <span dangerouslySetInnerHTML={{ __html: t("settings.providers.yandexSetupStep3") }} />
                  <code className="st2-pv-setup-url">{t("settings.providers.yandexSetupStep3Url")}</code>
                  <span className="st2-pv-setup-note">{t("settings.providers.yandexSetupStep3Note")}</span>
                </li>
                <li dangerouslySetInnerHTML={{ __html: t("settings.providers.yandexSetupStep4") }} />
                <li dangerouslySetInnerHTML={{ __html: t("settings.providers.yandexSetupStep5") }} />
              </ol>
            </div>
          )}

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: "var(--ink-soft)", marginBottom: 8 }}>
              {t("settings.providers.customHeaders")}
            </div>
            <HeadersEditor rows={headerRows} onChange={setHeaderRows}
              lockedKeys={p.id === "yandex" ? new Set(["x-folder-id"]) : undefined} />
            <button
              className="st2-btn"
              style={{ marginTop: 10 }}
              onClick={handleSaveHeaders}
              disabled={headersSaving}
            >
              {headersSaving ? t("settings.providers.saving") : t("settings.providers.saveHeaders")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
