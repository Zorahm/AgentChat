/** MCP settings tab — server list with inline config editing. */

import { useCallback, useEffect, useState } from "react";
import {
  Plugs, Trash, CaretDown, CaretRight, ArrowsClockwise,
  Upload, FolderOpen, Plus, X, CheckCircle, XCircle,
} from "@phosphor-icons/react";
import { API_BASE } from "../../../utils/apiBase";
import type { MCPTransportConfig, MCPStdioConfig, MCPHttpConfig } from "../SettingsPanel";

interface ServerView {
  id: string;
  name: string;
  enabled: boolean;
  config: MCPTransportConfig;
  state: "stopped" | "running" | "error";
  last_error: string | null;
  tool_count: number;
  last_used: number | null;
}

interface ToolView {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface KVPair { key: string; value: string; }

function kvFromObj(obj: Record<string, string> | undefined): KVPair[] {
  return Object.entries(obj ?? {}).map(([key, value]) => ({ key, value }));
}
function kvToObj(pairs: KVPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) if (key.trim()) out[key.trim()] = value;
  return out;
}

interface StdioForm {
  transport: "stdio";
  command: string;
  argsText: string;
  env: KVPair[];
  runtime: "host" | "wsl";
}
interface HttpForm {
  transport: "http";
  url: string;
  headers: KVPair[];
}
type ConfigForm = StdioForm | HttpForm;

function configToForm(cfg: MCPTransportConfig): ConfigForm {
  if (cfg.transport === "stdio") {
    const c = cfg as MCPStdioConfig;
    return { transport: "stdio", command: c.command, argsText: (c.args ?? []).join("\n"), env: kvFromObj(c.env), runtime: c.runtime ?? "host" };
  }
  const c = cfg as MCPHttpConfig;
  return { transport: "http", url: c.url, headers: kvFromObj(c.headers) };
}
function formToConfig(form: ConfigForm): MCPTransportConfig {
  if (form.transport === "stdio") {
    return { transport: "stdio", command: form.command.trim(), args: form.argsText.split("\n").map((s) => s.trim()).filter(Boolean), env: kvToObj(form.env), runtime: form.runtime } as MCPStdioConfig;
  }
  return { transport: "http", url: form.url.trim(), headers: kvToObj(form.headers) } as MCPHttpConfig;
}

/* ── MCPTab ───────────────────────────────────────────────────────────── */

export function MCPTab() {
  const [servers, setServers] = useState<ServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers`);
      if (!r.ok) { setError(`HTTP ${r.status}`); return; }
      setServers(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Сеть");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onDelete = async (id: string) => {
    if (!confirm(`Удалить MCP-сервер '${id}'?`)) return;
    const r = await fetch(`${API_BASE}/mcp/servers/${id}`, { method: "DELETE" });
    if (!r.ok) { setError(`HTTP ${r.status}`); return; }
    if (expanded === id) setExpanded(null);
    await reload();
  };

  const onToggleEnabled = async (id: string, enabled: boolean) => {
    const r = await fetch(`${API_BASE}/mcp/servers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) { setError(`HTTP ${r.status}`); return; }
    await reload();
  };

  return (
    <>
      <div className="st2-row-between">
        <div>
          <h3 className="st2-h">
            <Plugs size={18} weight="duotone" style={{ verticalAlign: "-3px" }} /> MCP-серверы
          </h3>
          <p className="st2-sub">
            Внешние Model Context Protocol серверы. Включай нужные кнопкой 🔌 рядом с моделью в чате.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            className="st2-btn"
            title="Открыть папку конфига"
            onClick={() => fetch(`${API_BASE}/mcp/config-dir/open`, { method: "POST" }).catch(() => {})}
          >
            <FolderOpen size={14} />
          </button>
          <button className="st2-btn" onClick={() => setImporting(true)}>
            <Upload size={14} /> Импорт
          </button>
          <button className="st2-btn" onClick={reload} disabled={loading}>
            <ArrowsClockwise size={14} /> {loading ? "…" : "Обновить"}
          </button>
        </div>
      </div>

      {error && <div className="st2-error">{error}</div>}

      {servers.length === 0 && !loading && (
        <p className="st2-sub" style={{ color: "var(--muted)", marginTop: 0 }}>
          Нет серверов. Добавьте через форму или импортируйте из <code>claude_desktop_config.json</code>.
        </p>
      )}

      <div className="mcp-list">
        {servers.map((s) => (
          <ServerCard
            key={s.id}
            server={s}
            open={expanded === s.id}
            onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
            onDelete={() => onDelete(s.id)}
            onToggleEnabled={(en) => onToggleEnabled(s.id, en)}
            onChanged={reload}
          />
        ))}
      </div>

      {adding ? (
        <AddServerForm
          existingIds={new Set(servers.map((s) => s.id))}
          onCancel={() => setAdding(false)}
          onAdded={async () => { setAdding(false); await reload(); }}
        />
      ) : (
        <button className="mcp-add-btn" onClick={() => setAdding(true)}>
          <Plus size={14} /> Добавить сервер
        </button>
      )}

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={async () => { setImporting(false); await reload(); }}
        />
      )}
    </>
  );
}

/* ── KVEditor ─────────────────────────────────────────────────────────── */

function KVEditor({ pairs, onChange, keyPh = "KEY", valPh = "value" }: {
  pairs: KVPair[];
  onChange: (p: KVPair[]) => void;
  keyPh?: string;
  valPh?: string;
}) {
  const upd = (i: number, f: "key" | "value", v: string) =>
    onChange(pairs.map((p, j) => j === i ? { ...p, [f]: v } : p));
  return (
    <div className="mcp-kv">
      {pairs.map((p, i) => (
        <div key={i} className="mcp-kv-row">
          <input className="mcp-kv-key" value={p.key} onChange={(e) => upd(i, "key", e.target.value)} placeholder={keyPh} />
          <span className="mcp-kv-eq">=</span>
          <input className="mcp-kv-val" value={p.value} onChange={(e) => upd(i, "value", e.target.value)} placeholder={valPh} />
          <button className="mcp-kv-del" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <X size={11} />
          </button>
        </div>
      ))}
      <button className="mcp-kv-add" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
        <Plus size={11} /> Добавить
      </button>
    </div>
  );
}

/* ── ServerCard ───────────────────────────────────────────────────────── */

function ServerCard({ server, open, onToggle, onDelete, onToggleEnabled, onChanged }: {
  server: ServerView;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onToggleEnabled: (v: boolean) => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<ConfigForm>(() => configToForm(server.config));
  const [name, setName] = useState(server.name);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testTools, setTestTools] = useState<ToolView[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    setForm(configToForm(server.config));
    setName(server.name);
  }, [server.config, server.name]);

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers/${server.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || server.name, config: formToConfig(form) }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: string };
        setSaveErr(j.detail ?? `HTTP ${r.status}`);
        return;
      }
      onChanged();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestError(null);
    setTestTools(null);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers/${server.id}/test`, { method: "POST" });
      const j = await r.json() as { ok: boolean; tools?: ToolView[]; error?: string };
      if (j.ok) setTestTools(j.tools ?? []);
      else setTestError(j.error ?? `HTTP ${r.status}`);
      onChanged();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Сеть");
    } finally {
      setTesting(false);
    }
  };

  const dotColor =
    server.state === "running" ? "var(--accent, #4ade80)" :
    server.state === "error"   ? "var(--danger, #f87171)" : "var(--muted)";

  const summary = server.config.transport === "stdio"
    ? [(server.config as MCPStdioConfig).command, ...(server.config as MCPStdioConfig).args.slice(0, 2)].join(" ")
    : (server.config as MCPHttpConfig).url;

  return (
    <div className={`mcp-card${open ? " mcp-card--open" : ""}`}>
      <div className="mcp-head" onClick={onToggle}>
        <span className="mcp-dot" style={{ background: dotColor }} />
        <span className="mcp-name">{server.name}</span>
        <span className="mcp-tag">{server.config.transport}</span>
        <span className="mcp-summary">{summary}</span>
        <label className="mcp-toggle" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={server.enabled} onChange={(e) => onToggleEnabled(e.target.checked)} />
          <span>вкл</span>
        </label>
        {open ? <CaretDown size={13} className="mcp-chevron" /> : <CaretRight size={13} className="mcp-chevron" />}
      </div>

      {open && (
        <div className="mcp-body">
          {server.last_error && (
            <div className="st2-error" style={{ margin: "0 0 4px", position: "static" }}>{server.last_error}</div>
          )}

          <label className="mcp-field">
            <span>Название</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          {form.transport === "stdio"
            ? <StdioFields form={form} onChange={setForm} />
            : <HttpFields form={form} onChange={setForm} />}

          {saveErr && (
            <div className="st2-error" style={{ margin: "4px 0 0", position: "static" }}>{saveErr}</div>
          )}

          <div className="mcp-actions">
            <button className="st2-btn st2-btn--primary" onClick={save} disabled={saving}>
              {saving ? "Сохраняю…" : "Сохранить"}
            </button>
            <button className="st2-btn" onClick={test} disabled={testing || !server.enabled}>
              {testing ? "Проверка…" : "Проверить"}
            </button>
            <button className="st2-btn st2-btn--danger" style={{ marginLeft: "auto" }} onClick={onDelete}>
              <Trash size={13} /> Удалить
            </button>
          </div>

          {testError && (
            <div className="mcp-test-err"><XCircle size={14} weight="fill" /> {testError}</div>
          )}
          {testTools !== null && (
            <div className="mcp-test-ok">
              <CheckCircle size={14} weight="fill" />
              <span>
                {testTools.length === 0 ? "Подключено, инструментов нет" : `${testTools.length} инструментов`}
                {testTools.length > 0 && (
                  <ul className="mcp-tool-list">
                    {testTools.map((t) => (
                      <li key={t.name}>
                        <code>{t.name}</code>
                        {t.description && <span className="mcp-tool-desc"> — {t.description}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── StdioFields / HttpFields ─────────────────────────────────────────── */

function StdioFields({ form, onChange }: { form: StdioForm; onChange: (f: ConfigForm) => void }) {
  return (
    <>
      <label className="mcp-field">
        <span>Команда</span>
        <input value={form.command} onChange={(e) => onChange({ ...form, command: e.target.value })} placeholder="npx" />
      </label>
      <label className="mcp-field">
        <span>Аргументы <span className="mcp-hint">(по строке)</span></span>
        <textarea rows={3} value={form.argsText} onChange={(e) => onChange({ ...form, argsText: e.target.value })} placeholder={"-y\n@modelcontextprotocol/server-github"} />
      </label>
      <div className="mcp-field">
        <span>Переменные среды</span>
        <KVEditor pairs={form.env} onChange={(env) => onChange({ ...form, env })} keyPh="КЛЮЧ" valPh="значение" />
      </div>
      <div className="mcp-field">
        <span>Среда выполнения</span>
        <div style={{ display: "flex", gap: 20, marginTop: 4 }}>
          {(["host", "wsl"] as const).map((r) => (
            <label key={r} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 400 }}>
              <input type="radio" checked={form.runtime === r} onChange={() => onChange({ ...form, runtime: r })} />
              {r === "host" ? "Windows-хост" : "WSL"}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function HttpFields({ form, onChange }: { form: HttpForm; onChange: (f: ConfigForm) => void }) {
  return (
    <>
      <label className="mcp-field">
        <span>URL</span>
        <input value={form.url} onChange={(e) => onChange({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/sse" />
      </label>
      <div className="mcp-field">
        <span>Заголовки</span>
        <KVEditor pairs={form.headers} onChange={(headers) => onChange({ ...form, headers })} keyPh="Authorization" valPh="Bearer ..." />
      </div>
    </>
  );
}

/* ── AddServerForm ────────────────────────────────────────────────────── */

function AddServerForm({ existingIds, onCancel, onAdded }: {
  existingIds: Set<string>;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [form, setForm] = useState<ConfigForm>({ transport: "stdio", command: "", argsText: "", env: [], runtime: "host" });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onNameChange = (v: string) => {
    setName(v);
    setId(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  };

  const switchTransport = (t: "stdio" | "http") => {
    setTransport(t);
    setForm(t === "stdio"
      ? { transport: "stdio", command: "", argsText: "", env: [], runtime: "host" }
      : { transport: "http", url: "", headers: [] });
  };

  const submit = async () => {
    setErr(null);
    const trimId = id.trim();
    if (!trimId || !name.trim()) { setErr("ID и название обязательны"); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimId)) { setErr("ID: латиница/цифры, _ -"); return; }
    if (existingIds.has(trimId)) { setErr("Такой ID уже есть"); return; }
    if (form.transport === "stdio" && !form.command.trim()) { setErr("Команда обязательна"); return; }
    if (form.transport === "http" && !form.url.trim()) { setErr("URL обязателен"); return; }

    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: trimId, name: name.trim(), enabled: true, config: formToConfig(form) }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: string };
        setErr(j.detail ?? `HTTP ${r.status}`);
        return;
      }
      onAdded();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-add-form">
      <div className="mcp-add-form-head">
        <span>Новый сервер</span>
        <button className="mcp-add-form-close" onClick={onCancel}><X size={14} /></button>
      </div>

      <div className="mcp-add-grid">
        <label className="mcp-field">
          <span>Название</span>
          <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="GitHub MCP" />
        </label>
        <label className="mcp-field">
          <span>ID</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="github" />
        </label>
      </div>

      <div className="mcp-transport-tabs">
        {(["stdio", "http"] as const).map((t) => (
          <button key={t} className={`mcp-transport-tab${transport === t ? " active" : ""}`} onClick={() => switchTransport(t)}>
            {t}
          </button>
        ))}
      </div>

      {form.transport === "stdio"
        ? <StdioFields form={form} onChange={setForm} />
        : <HttpFields form={form} onChange={setForm} />}

      {err && <div className="st2-error" style={{ margin: "10px 0 0", position: "static" }}>{err}</div>}

      <div className="mcp-actions" style={{ marginTop: 14 }}>
        <button className="st2-btn st2-btn--primary" onClick={submit} disabled={saving}>
          {saving ? "Добавляю…" : "Добавить"}
        </button>
        <button className="st2-btn" onClick={onCancel} disabled={saving}>Отмена</button>
      </div>
    </div>
  );
}

/* ── ImportModal ──────────────────────────────────────────────────────── */

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setErr(null);
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { setErr("Не валидный JSON"); return; }

    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: string };
        setErr(j.detail ?? `HTTP ${r.status}`);
        return;
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-add-form" style={{ marginTop: 12 }}>
      <div className="mcp-add-form-head">
        <span>Импорт из JSON</span>
        <button className="mcp-add-form-close" onClick={onClose}><X size={14} /></button>
      </div>
      <p className="st2-sub2">
        Вставьте содержимое <code>claude_desktop_config.json</code> или объект <code>{`{ "mcpServers": { ... } }`}</code>.
        Существующие серверы с тем же id будут перезаписаны.
      </p>
      <textarea
        rows={10}
        style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12, boxSizing: "border-box" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_TOKEN": "ghp_..." }\n    }\n  }\n}`}
      />
      {err && <div className="st2-error" style={{ margin: "8px 0 0", position: "static" }}>{err}</div>}
      <div className="mcp-actions" style={{ marginTop: 12 }}>
        <button className="st2-btn st2-btn--primary" onClick={submit} disabled={saving}>
          {saving ? "…" : "Импортировать"}
        </button>
        <button className="st2-btn" onClick={onClose} disabled={saving}>Отмена</button>
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function parseKV(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

void parseKV; // referenced only by the now-removed textarea-based form; kept to avoid removal warnings
