"""Core shared types for the agent system."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ToolFunction(BaseModel):
    """Function call within a tool call request."""

    name: str
    arguments: str  # JSON-encoded string of kwargs


class ToolCall(BaseModel):
    """A tool call requested by the LLM."""

    id: str
    type: Literal["function"] = "function"
    function: ToolFunction


class ToolResult(BaseModel):
    """Result of executing a single tool call."""

    tool_call_id: str
    name: str
    success: bool
    output: str
    duration_ms: float = 0.0


class AgentStep(BaseModel):
    """One iteration of the agent loop — either a text reply or tool invocations."""

    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_results: list[ToolResult] | None = None
