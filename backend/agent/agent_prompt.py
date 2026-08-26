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

from agent.prompt import variables
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
    *,
    registry: ToolRegistry | None,
    cwd: str,
    mcp_names: Sequence[str],
    skills_block: str,
    plugins_block: str,
    lang: str,
    user_persona: str,
    agent_memory: str,
) -> RuntimeFacts:
    return RuntimeFacts(
        cwd=cwd,
        tools_block=registry.describe() if registry is not None else "",
        tool_names=", ".join(registry.list_names()) if registry is not None else "",
        skills_block=skills_block,
        plugins_block=plugins_block,
        mcp_block=", ".join(mcp_names),
        lang=lang,
        user_persona=user_persona,
        agent_memory=agent_memory,
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
    plugins_block: str = "",
    lang: str = "",
    agent_memory: str = "",
) -> PromptBuild:
    """Assemble the system prompt for *agent* (or the built-in one when None).

    Returns the full :class:`PromptBuild` rather than a bare string: the caller
    logs ``active_modules`` and ``cache_prefix_hash``, and the editor shows them.
    Passing ``registry`` late — after the per-request tool set, MCP proxies and
    the sandbox path are known — is what makes ``{tools}`` and ``{cwd}`` truthful.

    ``agent_memory`` only reaches the prompt through an explicit ``{memory}``
    in the persona; otherwise the caller appends the block after assembly (see
    ``AgentLoop.set_agent_memory``) so it stays out of the cacheable prefix.
    """
    ctx = make_context(
        user_name=user_name,
        shell=shell,
        model=model,
        describe_actions=describe_actions,
        show_widget=show_widget,
        has_skills=has_skills,
        # Derived from the registry rather than passed in: an agent whose
        # whitelist drops math_verify must not be told to call it. With no
        # registry (the editor's preview) the section stays, since the preview
        # is of the built-in prompt rather than of one request's toolset.
        has_math_verify=registry is None or registry.get("math_verify") is not None,
        # Derived, not passed: the section is worth its tokens only when there
        # is a roster to go with it.
        has_plugins=bool(plugins_block),
        agent=_spec(agent),
        runtime=_facts(
            registry=registry,
            cwd=cwd,
            mcp_names=mcp_names,
            skills_block=skills_block,
            plugins_block=plugins_block,
            lang=lang,
            user_persona=agent.user_persona if agent is not None else "",
            agent_memory=agent_memory,
        ),
    )
    return build_prompt(ctx)


def render_agent_text(
    text: str,
    *,
    agent: AgentConfig | None,
    user_name: str,
    shell: str,
    lang: str = "",
) -> str:
    """Substitute an agent's template variables in a standalone string.

    For text that is not part of the system prompt — today, the greeting.
    Rendering it here rather than in the UI keeps one implementation of the
    variable syntax: a second one in TypeScript would drift the first time a
    variable is added, and would have to be taught which ones are volatile.

    Tool- and sandbox-derived variables resolve to empty: a greeting is
    written before any chat (and therefore any working directory or registry)
    exists.
    """
    if not text:
        return ""
    ctx = make_context(
        user_name=user_name,
        shell=shell,
        agent=_spec(agent),
        runtime=RuntimeFacts(
            lang=lang,
            user_persona=agent.user_persona if agent is not None else "",
        ),
    )
    return variables.render(text, ctx)
