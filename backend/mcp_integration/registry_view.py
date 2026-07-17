"""Per-request registry that overlays MCP proxies onto the shared tool set.

The shared :class:`ToolRegistry` instance on ``app.state.tool_registry``
holds built-in tools (bash, read_file, write_file, read_skill) and lives
for the lifetime of the app. MCP proxies, by contrast, are picked per
chat — they depend on which servers the chat has enabled. Mutating the
shared registry per request would race; instead, we wrap it in a view
that only the current request sees.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.base import BaseTool
from tools.registry import ToolRegistry, inject_activity_field, strip_activity_field


class MCPAwareRegistry(ToolRegistry):
    """Composite registry — base tools + per-request MCP proxies.

    Reuses :class:`ToolRegistry` semantics (so :class:`AgentLoop` doesn't
    know about MCP), but reads tools from two layers: a shared base
    registry and a list of additional proxies. Name collisions resolve
    to the proxy (MCP tools are namespaced ``mcp__*`` so a collision
    shouldn't happen, but the rule is defensive).
    """

    def __init__(self, base: ToolRegistry, proxies: list[BaseTool]) -> None:
        super().__init__()
        # Register only the proxies in the parent dict; we resolve base
        # lookups dynamically so changes to the base after construction
        # are still visible.
        self._base = base
        for proxy in proxies:
            self.register(proxy)

    # ------------------------------------------------------------------
    # ToolRegistry surface
    # ------------------------------------------------------------------

    def get(self, name: str) -> BaseTool | None:
        proxy = self._tools.get(name)
        if proxy is not None:
            return proxy
        return self._base.get(name)

    def list_names(self) -> list[str]:
        names = list(self._base.list_names())
        names.extend(n for n in self._tools.keys() if n not in names)
        return names

    def to_openai_schema(self, describe_actions: bool = False) -> list[dict[str, Any]]:
        overlay_schemas = [t.get_definition().model_dump() for t in self._tools.values()]
        if describe_actions:
            # Covers our own overlay tools (web_search, research); real MCP
            # server schemas (name starts with "mcp__") are skipped inside.
            overlay_schemas = inject_activity_field(overlay_schemas)
        return self._base.to_openai_schema(describe_actions) + overlay_schemas

    async def execute(self, name: str, arguments: dict[str, Any]) -> str:
        proxy = self._tools.get(name)
        if proxy is not None:
            try:
                return await proxy.execute(**strip_activity_field(arguments))
            except TypeError as e:
                return f"Error: invalid arguments for '{name}' — {e}"
        return await self._base.execute(name, arguments)

    def get_skill_md_path(self, skill_name: str) -> Path | None:
        return self._base.get_skill_md_path(skill_name)
