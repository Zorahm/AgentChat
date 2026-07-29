"""Pydantic models for agent profiles.

An agent is a persisted persona attachable to a chat: a name, a gradient
avatar (two colors), and an optional system-prompt override. Persisted inside
``settings.json`` under the ``agents`` block and round-tripped over the
``/api/agents`` endpoints — same shape as MCP servers.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")

# The seeded, non-deletable agent used when a chat has no agent_id, or its
# chosen agent was since deleted.
DEFAULT_AGENT_ID = "default"


class AgentConfig(BaseModel):
    """One configured agent profile.

    ``system_prompt`` empty means "use AgentChat's built-in dynamic prompt"
    (tool descriptions, sandbox rules, safety rules — refreshed every turn
    with the current date/shell/model). Non-empty REPLACES that prompt
    verbatim for every chat using this agent, including the default one —
    the caller is responsible for warning the user about the risk.
    """

    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)
    name: str = Field(min_length=1, max_length=80)
    color_from: str = Field(default="#7c6fdc", pattern=_HEX_COLOR_RE.pattern)
    color_to: str = Field(default="#4f9dde", pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str = ""


class AgentCreate(BaseModel):
    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)
    name: str = Field(min_length=1, max_length=80)
    color_from: str = Field(default="#7c6fdc", pattern=_HEX_COLOR_RE.pattern)
    color_to: str = Field(default="#4f9dde", pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str = ""


class AgentUpdate(BaseModel):
    name: str | None = None
    color_from: str | None = Field(default=None, pattern=_HEX_COLOR_RE.pattern)
    color_to: str | None = Field(default=None, pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str | None = None
