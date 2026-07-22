/** Connectors (MCP servers) — a "+" menu row that opens a side flyout of
 * per-chat server toggles. */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plugs, CaretRight } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Badge } from "@astryxdesign/core/Badge";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
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
      <DropdownMenuItem
        icon={<Plugs />}
        label={t("chat.mcp.servers")}
        onClick={() => setOpen((v) => !v)}
        endContent={
          <>
            {enabledIds.length > 0 && <Badge variant="blue" label={String(enabledIds.length)} />}
            <CaretRight />
          </>
        }
        className="cpm-item"
      />

      {open && (
        <div className="cpm-flyout">
          {loading && usable.length === 0 ? (
            <div className="cpm-flyout-empty">{t("chat.mcp.loading")}</div>
          ) : usable.length === 0 ? (
            <div className="cpm-flyout-empty">{t("chat.mcp.none")}</div>
          ) : (
            <div className="cpm-mcp-list">
              {usable.map((s) => (
                <div key={s.id} className="cpm-mcp-item">
                  <Switch
                    value={enabledSet.has(s.id)}
                    onChange={() => onToggle(s.id)}
                    label={s.name}
                    labelPosition="start"
                    labelSpacing="spread"
                  />
                  <div className="cpm-mcp-meta">
                    <StatusDot
                      variant={s.state === "running" ? "success" : s.state === "error" ? "error" : "neutral"}
                      label={s.state}
                    />
                    <span className="cpm-mcp-tools">{s.tool_count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            label={t("chat.mcp.manage")}
            onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "settings" }))}
            width="full"
          />
        </div>
      )}
    </div>
  );
}
