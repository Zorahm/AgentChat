"""What the attached agent contributes to one chat request.

Pulled out of :mod:`api.chat` because these are decisions, not plumbing, and
inline they were unreachable without a live LLM. Each has a failure mode that
is silent rather than loud: a character answering on the wrong model, a
roleplay agent quietly handed the web, or its memory printed twice and read as
two competing sets of facts.

Pure — no request, no app state, no I/O beyond reading the memory store.
"""

from __future__ import annotations

from dataclasses import dataclass

from agent.prompt import variables
from schemas.agents import DEFAULT_AGENT_ID, AgentConfig, ToolPolicy
from store.memory_store import MemoryStore, render_core_block


@dataclass(frozen=True)
class AgentRuntime:
    """The agent-derived half of one request's configuration."""

    agent: AgentConfig | None
    agent_id: str
    model: str
    temperature: float
    tool_policy: ToolPolicy
    # None whenever memory must not be wired — either the agent has it off or
    # there is no agent. The tool factory reads exactly this to decide whether
    # the memory tools exist at all.
    memory_store: MemoryStore | None
    # The rendered facts, for a persona that interpolates {memory} itself.
    memory_block: str
    # The copy to append after the assembled prompt — empty when the persona
    # already placed it.
    appended_memory: str

    @property
    def allows_overlays(self) -> bool:
        """Whether MCP proxies, web search and research may be wired.

        They are built in ``api.chat`` rather than the tool factory, so the
        policy has to be re-applied there; this is the single place that says
        what the policy means for them.
        """
        return self.tool_policy == "full"


def resolve_agent_runtime(
    *,
    agent: AgentConfig | None,
    requested_model: str | None,
    default_model: str,
    default_temperature: float,
    memory_store: MemoryStore | None,
) -> AgentRuntime:
    """Resolve *agent* against the request and the global settings.

    Model precedence is agent → request → default: a persona pinned to a model
    is usually pinned to a *fine-tune*, and answering on whatever the chat
    header happened to show would change the character, not just the latency.

    Temperature is checked against ``None`` rather than truthiness, so an agent
    deliberately set to 0.0 isn't read as "unset" and bumped back to the global
    value.
    """
    resolved_model = (agent.model if agent else "") or requested_model or default_model
    temperature = (
        agent.temperature
        if agent is not None and agent.temperature is not None
        else default_temperature
    )
    policy: ToolPolicy = agent.tool_policy if agent else "full"

    store = memory_store if agent is not None and agent.memory_enabled else None
    agent_id = agent.id if agent else DEFAULT_AGENT_ID
    # Mirrors what tools.factory will actually register: memory tools exist
    # only when a store is wired AND the policy allows any tool at all. An
    # agent with memory but `none` still gets its facts — it just isn't told
    # to `recall` more of them, because it can't.
    has_memory_tools = store is not None and policy != "none"
    block = (
        render_core_block(store.core(agent_id), has_search=has_memory_tools)
        if store is not None
        else ""
    )
    placed_by_persona = agent is not None and variables.references(
        agent.system_prompt, "memory"
    )

    return AgentRuntime(
        agent=agent,
        agent_id=agent_id,
        model=resolved_model,
        temperature=temperature,
        tool_policy=policy,
        memory_store=store,
        memory_block=block,
        appended_memory="" if placed_by_persona else block,
    )
