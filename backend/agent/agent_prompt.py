"""Compose one request's system prompt from settings, agent and runtime facts.

:func:`agent.system_prompt.build_system_prompt` renders a
:class:`~agent.prompt.context.PromptContext`; this module is what *fills* one
for a configured agent — turning the live tool registry, the chat's working
directory and the enabled MCP servers into the plain text the persona's ``{…}``
variables interpolate.

Shared by the chat route and the agent editor's preview so the prompt a user
inspects in Settings is assembled by exactly the same code as the one that runs.
"""

from __future__ import annotations

from collections.abc import Sequence

from agent.prompt.context import AgentSpec, RuntimeFacts
from agent.prompt.modules import PromptBuild
from agent.system_prompt import build_prompt, make_context
from schemas.agents import AgentConfig
from tools.registry import ToolRegistry


def _spec(agent: AgentConfig | None) -> AgentSpec:
    if agent is None:
        return AgentSpec()
    return AgentSpec(
        name=agent.name,
        persona=agent.system_prompt,
        prompt_mode=agent.prompt_mode,
        disabled_modules=frozenset(agent.disabled_modules),
    )


def _facts(
    registry: ToolRegistry | None,
    cwd: str,
    mcp_names: Sequence[str],
    skills_block: str,
    lang: str,
) -> RuntimeFacts:
    return RuntimeFacts(
        cwd=cwd,
        tools_block=registry.describe() if registry is not None else "",
        tool_names=", ".join(registry.list_names()) if registry is not None else "",
        skills_block=skills_block,
        mcp_block=", ".join(mcp_names),
        lang=lang,
    )


def build_agent_prompt(
    *,
    agent: AgentConfig | None,
    user_name: str,
    shell: str,
    model: str = "",
    describe_actions: bool = False,
    show_widget: bool = True,
    has_skills: bool = True,
    registry: ToolRegistry | None = None,
    cwd: str = "",
    mcp_names: Sequence[str] = (),
    skills_block: str = "",
    lang: str = "",
) -> PromptBuild:
    """Assemble the system prompt for *agent* (or the built-in one when None).

    Returns the full :class:`PromptBuild` rather than a bare string: the caller
    logs ``active_modules`` and ``cache_prefix_hash``, and the editor shows them.
    Passing ``registry`` late — after the per-request tool set, MCP proxies and
    the sandbox path are known — is what makes ``{tools}`` and ``{cwd}`` truthful.
    """
    ctx = make_context(
        user_name=user_name,
        shell=shell,
        model=model,
        describe_actions=describe_actions,
        show_widget=show_widget,
        has_skills=has_skills,
        agent=_spec(agent),
        runtime=_facts(registry, cwd, mcp_names, skills_block, lang),
    )
    return build_prompt(ctx)
