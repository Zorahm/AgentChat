"""MCP (Model Context Protocol) integration for AgentChat.

The package wires external MCP servers — both ``stdio`` subprocesses and
remote ``streamable_http`` endpoints — into the agent's tool registry.

Public surface:

- :class:`MCPManager` — lazy-spawn process supervisor with idle eviction
- :class:`MCPToolProxy` — adapts a remote tool into a :class:`BaseTool`
- :class:`MCPServerConfig` — Pydantic schema persisted in ``settings.json``
"""

from __future__ import annotations

from mcp_integration.config import (
    MCPHttpConfig,
    MCPServerConfig,
    MCPStdioConfig,
)
from mcp_integration.manager import MCPManager, MCPServerStatus
from mcp_integration.tool_proxy import MCPToolProxy

__all__ = [
    "MCPHttpConfig",
    "MCPServerConfig",
    "MCPStdioConfig",
    "MCPManager",
    "MCPServerStatus",
    "MCPToolProxy",
]
