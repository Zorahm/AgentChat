"""Internal data structures passed between the lead, the fan-out and the workers.

Dataclasses rather than Pydantic: none of these cross an API boundary — the only
things that leave the backend are progress events (see :mod:`research.progress`)
and the report file.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class ModelEndpoint:
    """Everything needed to point one nested ``AgentLoop`` at a provider.

    ``model`` is the canonical id the user picked in Settings (what the usage
    dashboard groups by); ``lite_model`` is the same id re-tagged for LiteLLM
    routing. Keeping both means usage rows stay readable while requests route.
    """

    provider_id: str
    model: str
    lite_model: str
    api_key: str | None = None
    api_base: str | None = None
    extra_headers: dict[str, str] | None = None


@dataclass(frozen=True, slots=True)
class PlanStep:
    """One entry of the lead's plan, as shown in the research panel."""

    id: str
    title: str


@dataclass(frozen=True, slots=True)
class SubagentTask:
    """One delegated sub-investigation. Both fields are authored by the lead."""

    title: str
    prompt: str


@dataclass(slots=True)
class Finding:
    """What one subagent brought back — the lead's only view of its work."""

    agent_id: str
    title: str
    status: str = "ok"  # ok | failed | timeout | cancelled
    summary: str = ""
    sources: list[str] = field(default_factory=list)
    gaps: str = ""
    error: str = ""


@dataclass(slots=True)
class ResearchOutcome:
    """Result of one research run, as handed back to the calling agent."""

    ok: bool
    title: str = ""
    report: str = ""
    path: str = ""
    message: str = ""
    warnings: list[str] = field(default_factory=list)
