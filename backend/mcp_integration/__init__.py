"""MCP (Model Context Protocol) integration for AgentChat.

The package wires external MCP servers — both ``stdio`` subprocesses and
remote ``streamable_http`` endpoints — into the agent's tool registry.

Public surface:

- :class:`MCPManager` — lazy-spawn process supervisor with idle eviction
- :class:`MCPToolProxy` — adapts a remote tool into a :class:`BaseTool`
- :class:`MCPServerConfig` — re-exported from :mod:`schemas.mcp`, where the
  Pydantic schema persisted in ``settings.json`` now lives
"""

from __future__ import annotations

from mcp_integration.manager import MCPManager, MCPServerStatus
from mcp_integration.tool_proxy import MCPToolProxy
from schemas.mcp import MCPHttpConfig, MCPServerConfig, MCPStdioConfig

__all__ = [
    "MCPHttpConfig",
    "MCPServerConfig",
    "MCPStdioConfig",
    "MCPManager",
    "MCPServerStatus",
    "MCPToolProxy",
]
