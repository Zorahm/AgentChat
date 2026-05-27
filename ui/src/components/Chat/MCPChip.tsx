/** MCP-server toggles, rendered as a section inside the composer "+" menu.
 * Returns null when there are no usable (enabled) servers. */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plugs } from "@phosphor-icons/react";
import { API_BASE } from "../../utils/apiBase";

interface ServerLite {
  id: string;
  name: string;
  enabled: boolean;
  state: "stopped" | "running" | "error";
  tool_count: number;
}

interface McpMenuSectionProps {
  enabledIds: string[];
  onToggle: (serverId: string) => void;
}

export function McpMenuSection({ enabledIds, onToggle }: McpMenuSectionProps) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<ServerLite[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers`);
      if (r.ok) setServers(await r.json());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const usable = servers.filter((s) => s.enabled);
  const enabledSet = new Set(enabledIds);

  if (!loading && usable.length === 0) return null;

  return (
    <div className="cpm-mcp">
      <div className="cpm-mcp-head"><Plugs size={13} /> {t("chat.mcp.servers")}</div>
      {loading && usable.length === 0 ? (
        <div className="cpm-mcp-empty">{t("chat.mcp.loading")}</div>
      ) : (
        usable.map((s) => {
          const on = enabledSet.has(s.id);
          return (
            <label key={s.id} className="cpm-mcp-item">
              <input type="checkbox" checked={on} onChange={() => onToggle(s.id)} />
              <span className="cpm-mcp-name">{s.name}</span>
              <span className={`mcp-chip-dot mcp-chip-dot--${s.state}`} />
              <span className="cpm-mcp-tools">{s.tool_count}</span>
            </label>
          );
        })
      )}
    </div>
  );
}
