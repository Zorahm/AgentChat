"""Abstract base class for all tools."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolSchema(BaseModel):
    """OpenAI-compatible function schema for a tool."""

    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=lambda: {
        "type": "object",
        "properties": {},
        "required": [],
    })


class ToolDefinition(BaseModel):
    """Full OpenAI-compatible tool definition consumed by LiteLLM."""

    type: Literal["function"] = "function"
    function: ToolSchema


class BaseTool(ABC):
    """Abstract tool. Subclasses override name, description, get_definition, execute."""

    name: str
    description: str

    @abstractmethod
    def get_definition(self) -> ToolDefinition:
        """Return the OpenAI-compatible tool definition for LiteLLM."""
        ...

    @abstractmethod
    async def execute(self, **kwargs: Any) -> str | list[dict[str, Any]]:
        """Execute the tool with parsed arguments.

        Returns either a plain string or an OpenAI-compatible content list
        (e.g. image blocks) that is passed directly as the tool message content.
        """
        ...
