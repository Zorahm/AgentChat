"""Tool registry — register tools by name, execute by name."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.base import BaseTool


class ToolRegistry:
    """Holds registered tools and dispatches execution by name."""

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register a tool instance. Name collisions overwrite silently."""
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> None:
        """Remove a tool by name. No-op if not found."""
        self._tools.pop(name, None)

    def get(self, name: str) -> BaseTool | None:
        """Look up a tool by name."""
        return self._tools.get(name)

    def list_names(self) -> list[str]:
        """Return all registered tool names."""
        return list(self._tools.keys())

    def to_openai_schema(self) -> list[dict[str, Any]]:
        """Produce the list of OpenAI-compatible tool dicts for LiteLLM."""
        return [tool.get_definition().model_dump() for tool in self._tools.values()]

    async def execute(self, name: str, arguments: dict[str, Any]) -> str | list[dict[str, Any]]:
        """Execute a registered tool by name with keyword arguments."""
        tool = self._tools.get(name)
        if tool is None:
            return f"Error: unknown tool '{name}'. Available: {self.list_names()}"
        try:
            return await tool.execute(**arguments)
        except TypeError as e:
            return f"Error: invalid arguments for '{name}' — {e}"

    def get_skill_md_path(self, skill_name: str) -> Path | None:
        """Return the absolute path to a skill's SKILL.md, or None."""
        from tools.read_skill import ReadSkillTool

        tool = self._tools.get("read_skill")
        if not isinstance(tool, ReadSkillTool):
            return None
        entry = tool._reader.get(skill_name)
        if entry is None:
            return None
        return entry.path / "SKILL.md"
