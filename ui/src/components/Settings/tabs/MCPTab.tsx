/** MCP settings tab — server list with inline config editing. */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plugs, Trash, CaretDown, CaretRight, ArrowsClockwise,
  Upload, FolderOpen, Plus, X, CheckCircle, XCircle, Terminal,
} from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Switch } from "@astryxdesign/core/Switch";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
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
  const { t } = useTranslation();
  const [servers, setServers] = useState<ServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addInitial, setAddInitial] = useState<AddInitial | null>(null);
  const [importing, setImporting] = useState(false);
  const [installing, setInstalling] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers`);
      if (!r.ok) { setError(`HTTP ${r.status}`); return; }
      setServers(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.mcp.errorNetwork"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onDelete = async (id: string) => {
    if (!confirm(t("settings.mcp.deleteConfirm", { id }))) return;
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
            <Plugs size={18} weight="duotone" style={{ verticalAlign: "-3px" }} /> {t("settings.mcp.title")}
          </h3>
          <p className="st2-sub">
            {t("settings.mcp.description")}
          </p>
        </div>
        <div className="mcp-header-actions">
          <IconButton
            label={t("settings.mcp.openConfigFolder")}
            icon={<FolderOpen size={14} />}
            onClick={() => fetch(`${API_BASE}/mcp/config-dir/open`, { method: "POST" }).catch(() => {})}
            variant="secondary"
            size="sm"
          />
          <Button
            label={t("settings.mcp.installCmd")}
            icon={<Terminal size={14} />}
            onClick={() => setInstalling(true)}
            variant="secondary"
            size="sm"
          />
          <Button
            label={t("settings.mcp.import")}
            icon={<Upload size={14} />}
            onClick={() => setImporting(true)}
            variant="secondary"
            size="sm"
          />
          <Button
            label={loading ? "…" : t("settings.mcp.refresh")}
            icon={<ArrowsClockwise size={14} />}
            onClick={reload}
            isDisabled={loading}
            isLoading={loading}
            variant="secondary"
            size="sm"
          />
        </div>
      </div>

      {error && <div className="st2-error">{error}</div>}

      {servers.length === 0 && !loading && (
        <p className="st2-sub" style={{ color: "var(--muted)", marginTop: 0 }}>
          {t("settings.mcp.empty")}
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
          key={addInitial ? "prefill" : "blank"}
          initial={addInitial ?? undefined}
          existingIds={new Set(servers.map((s) => s.id))}
          onCancel={() => { setAdding(false); setAddInitial(null); }}
          onAdded={async () => { setAdding(false); setAddInitial(null); await reload(); }}
        />
      ) : (
        <Button
          label={t("settings.mcp.addServer")}
          icon={<Plus size={14} />}
          onClick={() => { setAddInitial(null); setAdding(true); }}
          variant="secondary"
        />
      )}

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={async () => { setImporting(false); await reload(); }}
        />
      )}

      {installing && (
        <InstallModal
          onClose={() => setInstalling(false)}
          onUseCommand={(init) => { setInstalling(false); setAddInitial(init); setAdding(true); }}
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
  const { t } = useTranslation();
  const upd = (i: number, f: "key" | "value", v: string) =>
    onChange(pairs.map((p, j) => j === i ? { ...p, [f]: v } : p));
  return (
    <div className="mcp-kv">
      {pairs.map((p, i) => (
        <div key={i} className="mcp-kv-row">
          <input className="mcp-kv-key" value={p.key} onChange={(e) => upd(i, "key", e.target.value)} placeholder={keyPh} />
          <span className="mcp-kv-eq">=</span>
          <input className="mcp-kv-val" value={p.value} onChange={(e) => upd(i, "value", e.target.value)} placeholder={valPh} />
          <IconButton
            label={t("common.remove")}
            icon={<X size={11} />}
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            variant="ghost"
            size="sm"
          />
        </div>
      ))}
      <Button
        label={t("settings.mcp.add")}
        icon={<Plus size={11} />}
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
        variant="secondary"
        size="sm"
      />
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
  const { t } = useTranslation();
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
      setSaveErr(e instanceof Error ? e.message : t("settings.mcp.errorNetwork"));
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
      setTestError(e instanceof Error ? e.message : t("settings.mcp.errorNetwork"));
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
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            label={t("settings.mcp.enabled")}
            value={server.enabled}
            onChange={(v) => onToggleEnabled(v)}
            isLabelHidden={false}
            labelPosition="end"
            labelSpacing="hug"
          />
        </div>
        {open ? <CaretDown size={13} className="mcp-chevron" /> : <CaretRight size={13} className="mcp-chevron" />}
      </div>

      {open && (
        <div className="mcp-body">
          {server.last_error && (
            <div className="st2-error" style={{ margin: "0 0 4px", position: "static" }}>{server.last_error}</div>
          )}

          <label className="mcp-field">
            <span>{t("settings.mcp.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          {form.transport === "stdio"
            ? <StdioFields form={form} onChange={setForm} />
            : <HttpFields form={form} onChange={setForm} />}

          {saveErr && (
            <div className="st2-error" style={{ margin: "4px 0 0", position: "static" }}>{saveErr}</div>
          )}

          <div className="mcp-actions">
            <Button
              label={saving ? t("settings.mcp.saving") : t("settings.mcp.save")}
              onClick={save}
              isDisabled={saving}
              isLoading={saving}
              variant="primary"
              size="sm"
            />
            <Button
              label={testing ? t("settings.mcp.testing") : t("settings.mcp.test")}
              onClick={test}
              isDisabled={testing || !server.enabled}
              isLoading={testing}
              variant="secondary"
              size="sm"
            />
            <Button
              label={t("settings.mcp.delete")}
              icon={<Trash size={13} />}
              onClick={onDelete}
              variant="destructive"
              size="sm"
              style={{ marginLeft: "auto" }}
            />
          </div>

          {testError && (
            <div className="mcp-test-err"><XCircle size={14} weight="fill" /> {testError}</div>
          )}
          {testTools !== null && (
            <div className="mcp-test-ok">
              <CheckCircle size={14} weight="fill" />
              <span>
                {testTools.length === 0 ? t("settings.mcp.connectedNoTools") : t("settings.mcp.connectedWithTools", { count: testTools.length })}
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
  const { t } = useTranslation();
  return (
    <>
      <label className="mcp-field">
        <span>{t("settings.mcp.command")}</span>
        <input value={form.command} onChange={(e) => onChange({ ...form, command: e.target.value })} placeholder={t("settings.mcp.commandPlaceholder")} />
      </label>
      <label className="mcp-field">
        <span>{t("settings.mcp.args")}</span>
        <textarea rows={3} value={form.argsText} onChange={(e) => onChange({ ...form, argsText: e.target.value })} placeholder={t("settings.mcp.argsPlaceholder")} />
      </label>
      <div className="mcp-field">
        <span>{t("settings.mcp.env")}</span>
        <KVEditor pairs={form.env} onChange={(env) => onChange({ ...form, env })} keyPh={t("settings.mcp.key")} valPh={t("settings.mcp.value")} />
      </div>
      <RadioList
        label={t("settings.mcp.runtime")}
        value={form.runtime}
        onChange={(val) => onChange({ ...form, runtime: val as "host" | "wsl" })}
        size="sm"
      >
        <RadioListItem value="host" label={t("settings.mcp.windows")} />
        <RadioListItem value="wsl" label={t("settings.mcp.wsl")} />
      </RadioList>
    </>
  );
}

function HttpFields({ form, onChange }: { form: HttpForm; onChange: (f: ConfigForm) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <label className="mcp-field">
        <span>{t("settings.mcp.url")}</span>
        <input value={form.url} onChange={(e) => onChange({ ...form, url: e.target.value })} placeholder={t("settings.mcp.urlPlaceholder")} />
      </label>
      <div className="mcp-field">
        <span>{t("settings.mcp.headers")}</span>
        <KVEditor pairs={form.headers} onChange={(headers) => onChange({ ...form, headers })} keyPh={t("settings.mcp.authKey")} valPh={t("settings.mcp.authValue")} />
      </div>
    </>
  );
}

/* ── AddServerForm ────────────────────────────────────────────────────── */

function AddServerForm({ existingIds, onCancel, onAdded, initial }: {
  existingIds: Set<string>;
  onCancel: () => void;
  onAdded: () => void;
  initial?: AddInitial;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [form, setForm] = useState<ConfigForm>(
    initial
      ? { transport: "stdio", command: initial.command, argsText: initial.args.join("\n"), env: [], runtime: initial.runtime }
      : { transport: "stdio", command: "", argsText: "", env: [], runtime: "host" },
  );
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
    if (!trimId || !name.trim()) { setErr(t("settings.mcp.validationIdName")); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimId)) { setErr(t("settings.mcp.validationIdFormat")); return; }
    if (existingIds.has(trimId)) { setErr(t("settings.mcp.validationIdExists")); return; }
    if (form.transport === "stdio" && !form.command.trim()) { setErr(t("settings.mcp.validationCommandRequired")); return; }
    if (form.transport === "http" && !form.url.trim()) { setErr(t("settings.mcp.validationUrlRequired")); return; }

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
        <span>{t("settings.mcp.newServer")}</span>
        <IconButton label={t("common.close")} icon={<X size={14} />} onClick={onCancel} variant="ghost" size="sm" />
      </div>

      <div className="mcp-add-grid">
        <label className="mcp-field">
          <span>{t("settings.mcp.name")}</span>
          <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder={t("settings.mcp.namePlaceholder")} />
        </label>
        <label className="mcp-field">
          <span>{t("settings.mcp.id")}</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder={t("settings.mcp.idPlaceholder")} />
        </label>
      </div>

      <RadioList
        label={t("settings.mcp.transport")}
        isLabelHidden
        value={transport}
        onChange={(val) => switchTransport(val as "stdio" | "http")}
        size="sm"
      >
        <RadioListItem value="stdio" label="stdio" />
        <RadioListItem value="http" label="http" />
      </RadioList>

      {form.transport === "stdio"
        ? <StdioFields form={form} onChange={setForm} />
        : <HttpFields form={form} onChange={setForm} />}

      {err && <div className="st2-error" style={{ margin: "10px 0 0", position: "static" }}>{err}</div>}

      <div className="mcp-actions" style={{ marginTop: 14 }}>
        <Button
          label={saving ? t("settings.mcp.adding") : t("settings.mcp.add")}
          onClick={submit}
          isDisabled={saving}
          isLoading={saving}
          variant="primary"
          size="sm"
        />
        <Button
          label={t("settings.mcp.cancel")}
          onClick={onCancel}
          isDisabled={saving}
          variant="secondary"
          size="sm"
        />
      </div>
    </div>
  );
}

/* ── ImportModal ──────────────────────────────────────────────────────── */

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setErr(null);
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { setErr(t("settings.mcp.invalidJson")); return; }

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
        <span>{t("settings.mcp.importTitle")}</span>
        <IconButton label={t("common.close")} icon={<X size={14} />} onClick={onClose} variant="ghost" size="sm" />
      </div>
      <p className="st2-sub2">
        {t("settings.mcp.importDescription")}
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
        <Button
          label={saving ? "…" : t("settings.mcp.importButton")}
          onClick={submit}
          isDisabled={saving}
          isLoading={saving}
          variant="primary"
          size="sm"
        />
        <Button
          label={t("settings.mcp.importCancel")}
          onClick={onClose}
          isDisabled={saving}
          variant="secondary"
          size="sm"
        />
      </div>
    </div>
  );
}

/* ── InstallModal ─────────────────────────────────────────────────────── */

interface InstallResult {
  ok: boolean;
  exit_code: number;
  output: string;
  timed_out: boolean;
}

function InstallModal({ onClose, onUseCommand }: {
  onClose: () => void;
  onUseCommand: (init: AddInitial) => void;
}) {
  const { t } = useTranslation();
  const [command, setCommand] = useState("");
  const [shell, setShell] = useState<"powershell" | "cmd">("powershell");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd) { setErr(t("settings.mcp.installEmpty")); return; }
    setErr(null);
    setResult(null);
    setRunning(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, shell }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: string };
        setErr(j.detail ?? `HTTP ${r.status}`);
        return;
      }
      setResult(await r.json() as InstallResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("settings.mcp.errorNetwork"));
    } finally {
      setRunning(false);
    }
  };

  const statusText = result
    ? result.timed_out
      ? t("settings.mcp.installTimedOut")
      : result.ok
        ? t("settings.mcp.installExitOk", { code: result.exit_code })
        : t("settings.mcp.installExitFail", { code: result.exit_code })
    : null;

  const parsed = command.trim() ? buildAddInitial(command) : null;

  return (
    <div className="mcp-add-form" style={{ marginTop: 12 }}>
      <div className="mcp-add-form-head">
        <span>{t("settings.mcp.installTitle")}</span>
        <IconButton label={t("common.close")} icon={<X size={14} />} onClick={onClose} variant="ghost" size="sm" />
      </div>
      <p className="st2-sub2">{t("settings.mcp.installDescription")}</p>

      <textarea
        rows={2}
        style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12, boxSizing: "border-box" }}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder={t("settings.mcp.installPlaceholder")}
      />

      <RadioList
        label={t("settings.mcp.installShell")}
        value={shell}
        onChange={(val) => setShell(val as "powershell" | "cmd")}
        size="sm"
      >
        <RadioListItem value="powershell" label="PowerShell" />
        <RadioListItem value="cmd" label="CMD" />
      </RadioList>

      <p className="st2-sub2" style={{ marginTop: 8, color: "var(--muted)" }}>{t("settings.mcp.installHostNote")}</p>

      {err && <div className="st2-error" style={{ margin: "8px 0 0", position: "static" }}>{err}</div>}

      {statusText && (
        <div className={result?.ok ? "mcp-test-ok" : "mcp-test-err"} style={{ marginTop: 8 }}>
          {result?.ok ? <CheckCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />} {statusText}
        </div>
      )}
      {result && result.output && (
        <pre
          style={{
            marginTop: 8, maxHeight: 240, overflow: "auto",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: "var(--font-mono)", fontSize: 12,
            background: "var(--bg-2, rgba(0,0,0,0.2))", padding: 10, borderRadius: 8,
          }}
        >
          {result.output}
        </pre>
      )}

      <div className="mcp-actions" style={{ marginTop: 12 }}>
        <Button
          label={running ? t("settings.mcp.installRunning") : t("settings.mcp.installRun")}
          onClick={run}
          isDisabled={running}
          isLoading={running}
          variant={result ? "secondary" : "primary"}
          size="sm"
        />
        {result && parsed && (
          <Button
            label={t("settings.mcp.installAddServer")}
            onClick={() => onUseCommand(parsed)}
            isDisabled={running}
            variant="primary"
            size="sm"
          />
        )}
        <Button
          label={t("settings.mcp.cancel")}
          onClick={onClose}
          isDisabled={running}
          variant="secondary"
          size="sm"
        />
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Initial values for the add-server form, parsed from an install command. */
interface AddInitial {
  id: string;
  name: string;
  command: string;
  args: string[];
  runtime: "host" | "wsl";
}

/** Split a shell-ish command line into tokens, honouring single/double quotes. */
function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Derive a slug id + display name from the package-looking token. */
function guessIdName(command: string, args: string[]): { id: string; name: string } {
  const pkg = args.find((a) => !a.startsWith("-")) ?? command;
  let base = pkg.split("/").pop() ?? pkg;        // @upstash/context7-mcp → context7-mcp
  base = base.replace(/^@/, "");
  base = base.replace(/[-_]?mcp([-_]server)?$/i, ""); // context7-mcp → context7
  base = base.replace(/^mcp[-_]?server[-_]?/i, "");   // mcp-server-git → git
  base = base.replace(/^server[-_]/i, "");
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp-server";
  const name = id.split("-").filter(Boolean).map((s) => s[0]!.toUpperCase() + s.slice(1)).join(" ") || "MCP Server";
  return { id, name };
}

/** Turn an install command into prefilled add-server values, or null if empty.
 *  Unwraps a `claude mcp add <id> -- <runner …>` wrapper to the real runner.
 *  Runtime is always "host" — these commands run on the host shell, not WSL. */
function buildAddInitial(raw: string): AddInitial | null {
  let tokens = tokenizeCommand(raw.trim());
  if (tokens.length === 0) return null;
  if (tokens[0] === "claude" && tokens.includes("--")) {
    tokens = tokens.slice(tokens.indexOf("--") + 1);
  }
  if (tokens.length === 0) return null;
  const command = tokens[0]!;
  const args = tokens.slice(1);
  const { id, name } = guessIdName(command, args);
  return { id, name, command, args, runtime: "host" };
}

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
