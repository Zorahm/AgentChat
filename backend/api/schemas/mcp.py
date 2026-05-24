"""Response models used by :mod:`api.mcp`.

The CRUD request models live in :mod:`mcp_integration.config` so they can
be shared with the persistence layer without circular imports.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class MCPServerView(BaseModel):
    """A server entry decorated with live runtime status — for the UI list."""

    id: str
    name: str
    enabled: bool
    config: dict[str, Any]
    state: str  # "stopped" | "running" | "error"
    last_error: str | None = None
    tool_count: int = 0
    last_used: float | None = None


class MCPToolView(BaseModel):
    """A single tool advertised by an MCP server."""

    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class MCPImportPayload(BaseModel):
    """Bulk import format compatible with ``claude_desktop_config.json``.

    Accepts either ``{ "mcpServers": { id: {...} } }`` or a bare
    ``{ id: {...} }`` mapping. Each value mirrors the canonical
    ``{ command, args, env }`` or ``{ url, headers }`` shape.
    """

    mcpServers: dict[str, dict[str, Any]] | None = None
    servers: dict[str, dict[str, Any]] | None = None


class MCPTestResult(BaseModel):
    """Outcome of a ``POST /mcp/servers/{id}/test`` call."""

    ok: bool
    tools: list[MCPToolView] = Field(default_factory=list)
    error: str | None = None
