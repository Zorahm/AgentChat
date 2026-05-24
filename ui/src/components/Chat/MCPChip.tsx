/** Per-chat MCP-server toggle chip. Lives next to the model selector. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plugs } from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";

interface ServerLite {
  id: string;
  name: string;
  enabled: boolean;
  state: "stopped" | "running" | "error";
  tool_count: number;
}

interface MCPChipProps {
  enabledIds: string[];
  onToggle: (serverId: string) => void;
}

export function MCPChip({ enabledIds, onToggle }: MCPChipProps) {
  const [servers, setServers] = useState<ServerLite[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers`);
      if (r.ok) setServers(await r.json());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const usable = servers.filter((s) => s.enabled);
  const enabledSet = new Set(enabledIds);
  const activeCount = usable.filter((s) => enabledSet.has(s.id)).length;

  if (usable.length === 0) return null;

  return (
    <div className="mcp-chip" ref={ref}>
      <button
        type="button"
        className={`mcp-chip-btn${activeCount > 0 ? " mcp-chip-btn--on" : ""}`}
        onClick={() => { setOpen((v) => !v); if (!open) void reload(); }}
        title="MCP-серверы для этого чата"
      >
        <Plugs size={14} weight={activeCount > 0 ? "fill" : "regular"} />
        <span>MCP {activeCount > 0 ? `${activeCount}/${usable.length}` : ""}</span>
      </button>

      {open && (
        <div className="mcp-chip-popover">
          <div className="mcp-chip-head">MCP-серверы</div>
          {loading && <div className="mcp-chip-empty">Загрузка…</div>}
          {!loading && usable.length === 0 && (
            <div className="mcp-chip-empty">Нет включённых серверов</div>
          )}
          {usable.map((s) => {
            const on = enabledSet.has(s.id);
            return (
              <label key={s.id} className="mcp-chip-item">
                <input type="checkbox" checked={on} onChange={() => onToggle(s.id)} />
                <span className="mcp-chip-name">{s.name}</span>
                <span className={`mcp-chip-dot mcp-chip-dot--${s.state}`} />
                <span className="mcp-chip-tools">{s.tool_count}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
