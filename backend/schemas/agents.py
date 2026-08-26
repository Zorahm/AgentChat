"""Pydantic models for agent profiles.

An agent is a persisted persona attachable to a chat: a name, a gradient
avatar (two colors), a prompt template, the list of built-in prompt modules it
switches off, and the roleplay-side settings (tool policy, memory, user
persona, greeting, sampling). Persisted inside ``settings.json`` under the
``agents`` block and round-tripped over the ``/api/agents`` endpoints — same
shape as MCP servers.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, model_validator

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

# What the agent is allowed to reach for. ``memory_only`` is what makes a
# roleplay agent work: a character that can still remember, but has no bash, no
# filesystem, no MCP and no web — the tool roster itself breaks the fiction
# long before the model does.
ToolPolicy = Literal["full", "memory_only", "none"]

# LiteLLM's accepted sampling range. Out-of-range values are rejected by the
# provider mid-stream, which surfaces to the user as a dead chat rather than a
# settings error.
TEMPERATURE_MIN = 0.0
TEMPERATURE_MAX = 2.0


class AgentFields(BaseModel):
    """Everything about an agent except its id.

    Shared by :class:`AgentConfig` and :class:`AgentCreate` so a new field can
    only ever be added to both. They used to be two hand-kept copies of the
    same list, and a field present in one but missing from the other is
    invisible until a user's edit silently fails to save.

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

    Every default reproduces pre-roleplay behaviour exactly — these models load
    agents written before the fields existed, and a "better" default would
    rewrite what a user's agent does without them touching it.
    """

    name: str = Field(min_length=NAME_MIN, max_length=NAME_MAX)
    color_from: str = Field(default="#7c6fdc", pattern=_HEX_COLOR_RE.pattern)
    color_to: str = Field(default="#4f9dde", pattern=_HEX_COLOR_RE.pattern)
    system_prompt: str = ""
    prompt_mode: PromptMode = "append"
    disabled_modules: list[str] = Field(default_factory=list)

    # ── roleplay / memory ────────────────────────────────────────────────
    tool_policy: ToolPolicy = "full"
    # A whitelist applied *on top of* ``tool_policy``. Empty means "no
    # restriction" — which is what every agent written before this field existed
    # deserializes to, so adding it changed nobody's agent.
    #
    # Separate from ``tool_policy`` because the two answer different questions.
    # The policy is a coarse posture (a character with no shell); this names the
    # exact roster, which is what a narrow specialist needs — a maths agent must
    # not be able to reach for web search and come back with someone else's
    # answer instead of working the problem. Applied in ``tools.factory`` for the
    # built-ins and again in ``api.chat`` for the overlays it doesn't build.
    allowed_tools: list[str] = Field(default_factory=list)
    memory_enabled: bool = False
    # Who the *user* is playing. Kept out of system_prompt so one character can
    # be reused across stories by swapping this alone; reaches the prompt as
    # the {user_persona} variable.
    user_persona: str = ""
    # Opening line, written into the chat tree verbatim — no model call.
    greeting: str = ""
    # None means "follow the global setting"; the same for an empty model id.
    temperature: float | None = Field(
        default=None, ge=TEMPERATURE_MIN, le=TEMPERATURE_MAX
    )
    model: str = ""

    @model_validator(mode="after")
    def _memory_only_needs_memory(self) -> AgentFields:
        """``memory_only`` without memory would ship zero tools.

        Refused rather than coerced: silently turning memory on (or silently
        degrading to ``none``) hides which of the two the user actually meant.
        """
        if self.tool_policy == "memory_only" and not self.memory_enabled:
            raise ValueError(
                "tool_policy 'memory_only' requires memory_enabled — "
                "use 'none' for an agent with no tools at all"
            )
        return self


class AgentConfig(AgentFields):
    """One configured agent profile, as persisted and served."""

    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)


class AgentCreate(AgentFields):
    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)


class AgentUpdate(BaseModel):
    """A patch. Every field optional, but a *present* field is fully validated.

    Deliberately NOT derived from :class:`AgentFields`: "absent" and "null"
    have to mean different things here. ``SettingsStore.update_agent`` applies
    it with ``exclude_unset``, so a field the client didn't send is left alone
    while an explicit ``null`` still lands — that is how ``temperature`` is
    handed back to the global setting.

    ``name`` carries the same bounds as :class:`AgentFields`: without them a
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
    tool_policy: ToolPolicy | None = None
    allowed_tools: list[str] | None = None
    memory_enabled: bool | None = None
    user_persona: str | None = None
    greeting: str | None = None
    temperature: float | None = Field(
        default=None, ge=TEMPERATURE_MIN, le=TEMPERATURE_MAX
    )
    model: str | None = None


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
    # Every tool name an agent may whitelist, including the overlays that
    # ``api.chat`` wires rather than the factory. Served rather than hardcoded in
    # the UI so a whitelist can never offer a tool this build doesn't ship.
    available_tools: list[str]


class AgentPreviewRequest(BaseModel):
    """A draft agent, for previewing the prompt it would actually produce.

    Sent from the editor on every debounce, so it carries the unsaved draft
    rather than an id.
    """

    name: str = ""
    system_prompt: str = ""
    prompt_mode: PromptMode = "append"
    disabled_modules: list[str] = Field(default_factory=list)
    user_persona: str = ""
    model: str = ""


class AgentPreviewResponse(BaseModel):
    """The assembled prompt plus the diagnostics the editor surfaces."""

    prompt: str
    active_modules: list[str]
    used_variables: list[str]
    unknown_variables: list[str]
    # False when the persona references {date}/{time}/{model}/{memory}, which
    # pushes text out of the provider's cacheable prefix.
    cacheable: bool


class AgentGreeting(BaseModel):
    """An agent's opening line with its template variables already resolved."""

    text: str
