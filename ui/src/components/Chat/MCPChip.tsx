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
import { mcpDot } from "../../utils/mcpStatus";

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
  const [probing, setProbing] = useState(false);
  const [open, setOpen] = useState(false);

  // Two passes on purpose. /mcp/servers answers instantly but can only report
  // what the lazy manager already knows — everything unused reads as
  // "stopped". /mcp/probe actually connects, so the list appears at once and
  // the dots settle a moment later instead of lying until someone presses Test.
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/servers`);
      if (r.ok) setServers(await r.json());
    } catch { /* ignore */ }
    finally { setLoading(false); }

    setProbing(true);
    try {
      const r = await fetch(`${API_BASE}/mcp/probe`, { method: "POST" });
      if (r.ok) setServers(await r.json());
    } catch { /* ignore — the un-probed states stay on screen */ }
    finally { setProbing(false); }
  }, []);

  // This section only mounts while the "+" menu is open, so the probe fires
  // exactly when the user is choosing connectors — never in the background.
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
              {usable.map((s) => {
                const dot = mcpDot(s.state, probing && s.state !== "running");
                return (
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
                        variant={dot.variant}
                        label={t(dot.labelKey)}
                        tooltip={t(dot.labelKey)}
                        isPulsing={dot.isPulsing}
                      />
                      <span className="cpm-mcp-tools">{s.tool_count}</span>
                    </div>
                  </div>
                );
              })}
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
