/** Connectors (MCP servers) — a "+" menu row that opens a side flyout of
 * per-chat server toggles. */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plugs, CaretRight } from "@phosphor-icons/react";
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
  const [open, setOpen] = useState(false);

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

  return (
    <div className="cpm-section cpm-connectors">
      <button className="cpm-item" onClick={() => setOpen((v) => !v)}>
        <Plugs />
        <span className="cpm-item-label">{t("chat.mcp.servers")}</span>
        {enabledIds.length > 0 && <span className="cpm-count">{enabledIds.length}</span>}
        <CaretRight className="cpm-arr" />
      </button>

      {open && (
        <div className="cpm-flyout">
          {loading && usable.length === 0 ? (
            <div className="cpm-flyout-empty">{t("chat.mcp.loading")}</div>
          ) : usable.length === 0 ? (
            <div className="cpm-flyout-empty">{t("chat.mcp.none")}</div>
          ) : (
            usable.map((s) => (
              <label key={s.id} className="cpm-mcp-item">
                <input
                  type="checkbox"
                  checked={enabledSet.has(s.id)}
                  onChange={() => onToggle(s.id)}
                />
                <span className="cpm-mcp-name">{s.name}</span>
                <span className={`mcp-chip-dot mcp-chip-dot--${s.state}`} />
                <span className="cpm-mcp-tools">{s.tool_count}</span>
              </label>
            ))
          )}
          <button
            className="cpm-flyout-manage"
            onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "settings" }))}
          >
            {t("chat.mcp.manage")}
          </button>
        </div>
      )}
    </div>
  );
}
