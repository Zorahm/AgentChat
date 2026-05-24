"""Adapter that exposes a remote MCP tool through the local :class:`BaseTool` API."""

from __future__ import annotations

from typing import Any

from mcp_integration.config import MCPServerConfig
from mcp_integration.manager import MCPManager
from tools.base import BaseTool, ToolDefinition, ToolSchema

# Tools are namespaced ``mcp__<server>__<tool>`` so they don't collide with
# the built-in roster and so the UI can identify them at a glance.
TOOL_PREFIX = "mcp__"


def _make_tool_name(server_id: str, tool_name: str) -> str:
    return f"{TOOL_PREFIX}{server_id}__{tool_name}"


def split_tool_name(qualified: str) -> tuple[str, str] | None:
    """Reverse of :func:`_make_tool_name`. Returns ``None`` if not an MCP tool."""
    if not qualified.startswith(TOOL_PREFIX):
        return None
    rest = qualified[len(TOOL_PREFIX) :]
    if "__" not in rest:
        return None
    server_id, tool_name = rest.split("__", 1)
    return server_id, tool_name


class MCPToolProxy(BaseTool):
    """Forwards a single MCP tool through the manager."""

    def __init__(
        self,
        manager: MCPManager,
        cfg: MCPServerConfig,
        tool_name: str,
        description: str,
        input_schema: dict[str, Any],
    ) -> None:
        self._manager = manager
        self._cfg = cfg
        self._remote_name = tool_name
        self.name = _make_tool_name(cfg.id, tool_name)
        self.description = f"[mcp:{cfg.id}] {description}" if description else f"[mcp:{cfg.id}]"
        self._schema = input_schema

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters=self._schema,
            )
        )

    async def execute(self, **kwargs: Any) -> str:
        try:
            return await self._manager.call_tool(self._cfg, self._remote_name, kwargs)
        except Exception as exc:  # noqa: BLE001
            # Surface to the agent as a tool error rather than crashing the
            # turn. The exception message already names the server / tool.
            return f"Error calling MCP tool '{self._remote_name}': {exc}"
