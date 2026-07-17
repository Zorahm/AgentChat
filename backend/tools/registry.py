"""Tool registry — register tools by name, execute by name."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.base import BaseTool

# Shared optional argument overlaid onto every non-MCP tool schema when the
# user opts into model-authored action descriptions (Settings → Appearance).
# It never reaches a tool's `execute()` — see strip_activity_field.
ACTIVITY_FIELD = "activity"
_ACTIVITY_SCHEMA = {
    "type": "string",
    "description": (
        "One short sentence, in the language you're replying in, describing in "
        "your own words what you're doing with this specific call and why. "
        "Shown to the user in place of a generic status line, so make it "
        "concrete to this call rather than a restatement of the tool name."
    ),
}


def inject_activity_field(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add the shared ``activity`` property to every non-MCP tool schema.

    MCP tool schemas come from external servers we don't own, so they're left
    untouched — those calls keep their generic "used <server>" label.
    """
    for schema in schemas:
        if schema["function"]["name"].startswith("mcp__"):
            continue
        params = schema["function"]["parameters"]
        params.setdefault("properties", {})[ACTIVITY_FIELD] = _ACTIVITY_SCHEMA
    return schemas


def strip_activity_field(arguments: dict[str, Any]) -> dict[str, Any]:
    """Drop the shared ``activity`` key before dispatching to a tool's execute().

    Tools declare narrow, explicit ``execute()`` signatures with no catch-all
    kwarg, so passing it through unfiltered would raise TypeError.
    """
    if ACTIVITY_FIELD not in arguments:
        return arguments
    return {k: v for k, v in arguments.items() if k != ACTIVITY_FIELD}


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

    def to_openai_schema(self, describe_actions: bool = False) -> list[dict[str, Any]]:
        """Produce the list of OpenAI-compatible tool dicts for LiteLLM."""
        schemas = [tool.get_definition().model_dump() for tool in self._tools.values()]
        return inject_activity_field(schemas) if describe_actions else schemas

    async def execute(self, name: str, arguments: dict[str, Any]) -> str | list[dict[str, Any]]:
        """Execute a registered tool by name with keyword arguments."""
        tool = self._tools.get(name)
        if tool is None:
            return f"Error: unknown tool '{name}'. Available: {self.list_names()}"
        try:
            return await tool.execute(**strip_activity_field(arguments))
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
