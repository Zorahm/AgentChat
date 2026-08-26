"""Where MCP servers come from — the settings store *and* installed plugins.

An Agent Plugin's servers are never written into ``settings.json``: they are
derived from its ``mcp.json`` on every load, so deleting the plugin directory
is the whole of uninstalling them. That makes this the one place that knows
the full set, and every caller that used to reach for
``settings_store.list_mcp_servers()`` goes through here instead.

Configured servers win a name clash. A plugin id is a derived slug carrying a
digest of both names, so a collision means the user typed one by hand — and
their own configuration is the one they can edit.
"""

from __future__ import annotations

import logging

from plugins.registry import PluginRegistry
from schemas.mcp import MCPServerConfig
from store.settings_store import SettingsStore

logger = logging.getLogger(__name__)


def all_mcp_servers(store: SettingsStore, registry: PluginRegistry) -> list[MCPServerConfig]:
    """Every MCP server this process can start, configured ones first."""
    servers = store.list_mcp_servers()
    taken = {s.id for s in servers}
    for cfg in registry.mcp_servers():
        if cfg.id in taken:
            logger.warning(
                "Plugin MCP server %r shadowed by a configured server of the same id", cfg.id
            )
            continue
        servers.append(cfg)
        taken.add(cfg.id)
    return servers


def find_mcp_server(
    store: SettingsStore, registry: PluginRegistry, server_id: str
) -> MCPServerConfig | None:
    """Look one server up by id across both sources."""
    configured = store.get_mcp_server(server_id)
    if configured is not None:
        return configured
    for cfg in registry.mcp_servers():
        if cfg.id == server_id:
            return cfg
    return None
