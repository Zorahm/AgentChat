"""Pydantic models for agent profiles.

An agent is a persisted persona attachable to a chat: a name, a gradient
avatar (two colors), a prompt template, and the list of built-in prompt modules
it switches off. Persisted inside ``settings.json`` under the ``agents`` block
and round-tripped over the ``/api/agents`` endpoints — same shape as MCP
servers.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")

NAME_MIN = 1
NAME_MAX = 80

# The seeded, non-deletable agent used when a chat has no agent_id, or its
# chosen agent was since deleted.
DEFAULT_AGENT_ID = "default"

# Mirrors APPEND_MODE / REPLACE_MODE in agent.prompt.context — this package is a
# leaf and must not import the app, so the two are kept in sync by
# tests/backend/test_system_prompt.py rather than by a shared import.
PromptMode = Literal["append", "replace"]


class AgentConfig(BaseModel):
    """One configured agent profile.

    ``system_prompt`` is a *template*: ``{date}``, ``{tools}``, ``{shell}`` and
    friends are substituted at every request, so a persona never goes stale the
    way a captured snapshot did. ``prompt_mode`` decides what it does with the
    built-in prompt — ``append`` keeps the tool contract, sandbox and safety
    rules and adds the persona as the last word, ``replace`` hands the whole
    prompt over to the template (which can pull pieces back in with ``{base}``
    and ``{block:<module>}``).

    ``disabled_modules`` names built-in sections to drop; only names in
    ``agent.prompt.registry.TOGGLEABLE_MODULES`` have any effect, so a stale
    entry can never strip the sandbox rules.
    """

    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)
    name: str = Field(min_length=NAME_MIN, max_length=NAME_MAX)
    color_from: str = Field(default="#7c6fdc", pattern=_HEX_COLOR_RE.pattern)
    color_to: str = Field(default="#4f9dde", pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str = ""
    prompt_mode: PromptMode = "append"
    disabled_modules: list[str] = Field(default_factory=list)


class AgentCreate(BaseModel):
    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)
    name: str = Field(min_length=NAME_MIN, max_length=NAME_MAX)
    color_from: str = Field(default="#7c6fdc", pattern=_HEX_COLOR_RE.pattern)
    color_to: str = Field(default="#4f9dde", pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str = ""
    prompt_mode: PromptMode = "append"
    disabled_modules: list[str] = Field(default_factory=list)


class AgentUpdate(BaseModel):
    """A patch. Every field optional, but a *present* field is fully validated.

    ``name`` carries the same bounds as :class:`AgentConfig`: without them a
    ``PUT {"name": ""}`` used to save an agent that failed validation on the
    next load and was dropped from settings.json — the agent silently vanished
    after a restart.
    """

    name: str | None = Field(default=None, min_length=NAME_MIN, max_length=NAME_MAX)
    color_from: str | None = Field(default=None, pattern=_HEX_COLOR_RE.pattern)
    color_to: str | None = Field(default=None, pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str | None = None
    prompt_mode: PromptMode | None = None
    disabled_modules: list[str] | None = None


class PromptVariable(BaseModel):
    """One entry of the template-variable palette shown in the agent editor."""

    name: str
    volatile: bool


class AgentEditorMeta(BaseModel):
    """Everything the agent editor needs before the user types anything.

    Static for a given build, so the UI fetches it once per mount rather than
    inferring the palette from a preview response.
    """

    variables: list[PromptVariable]
    toggleable_modules: list[str]


class AgentPreviewRequest(BaseModel):
    """A draft agent, for previewing the prompt it would actually produce.

    Sent from the editor on every debounce, so it carries the unsaved draft
    rather than an id.
    """

    name: str = ""
    system_prompt: str = ""
    prompt_mode: PromptMode = "append"
    disabled_modules: list[str] = Field(default_factory=list)
    model: str = ""


class AgentPreviewResponse(BaseModel):
    """The assembled prompt plus the diagnostics the editor surfaces."""

    prompt: str
    active_modules: list[str]
    used_variables: list[str]
    unknown_variables: list[str]
    # False when the persona references {date}/{time}/{model}, which pushes text
    # out of the provider's cacheable prefix.
    cacheable: bool
