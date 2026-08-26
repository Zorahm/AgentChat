"""System prompt entry point — a thin wrapper over the module registry.

The body lives in :mod:`agent.prompt` (a registry of :class:`PromptModule`
records). This module gathers the per-request dynamic inputs (resolved user
name, current day and clock) into a :class:`PromptContext` and assembles them,
so the long-standing ``build_system_prompt`` signature keeps working while
agent-aware callers can pass a persona and runtime facts as well.
"""

from __future__ import annotations

import os
import platform
from collections.abc import Iterable
from datetime import datetime

from agent.prompt.context import AgentSpec, PromptContext, RuntimeFacts
from agent.prompt.modules import PromptBuild, assemble
from agent.prompt.registry import TOGGLEABLE_MODULES, build_registry

_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _os_login() -> str:
    """``os.getlogin()`` raises OSError with no controlling terminal (e.g. under
    a service manager) — degrade to empty rather than crash prompt assembly."""
    try:
        return os.getlogin()
    except OSError:
        return ""


def _resolve_user_name(user_name: str) -> str:
    """Explicit name, else the OS login, else empty."""
    return user_name or os.environ.get("USER", os.environ.get("USERNAME", "")) or _os_login()


def _format_today(now: datetime) -> str:
    """Day-granularity date with an explicit English month.

    Minutes are deliberately dropped: a per-minute timestamp at the top of the
    prompt meant the cacheable prefix never matched between requests (see the
    cache invariant in agent.prompt.modules). The month is spelled out from a
    table rather than ``%B`` because ``%B`` is locale-dependent — on a Russian
    system it would splice Cyrillic into an otherwise-English prompt.
    """
    return f"{now:%d} {_MONTHS[now.month - 1]} {now:%Y}"


def normalize_disabled(names: Iterable[str]) -> frozenset[str]:
    """Keep only module names an agent is actually allowed to switch off.

    Silently dropping the rest means a stale settings.json naming a module that
    has since been renamed (or was never toggleable) can't quietly strip the
    sandbox rules out of every prompt.
    """
    return frozenset(n for n in names if n in TOGGLEABLE_MODULES)


def make_context(
    *,
    user_name: str = "",
    shell: str = "wsl",
    model: str = "",
    describe_actions: bool = False,
    show_widget: bool = True,
    has_skills: bool = True,
    has_plugins: bool = False,
    has_math_verify: bool = True,
    agent: AgentSpec | None = None,
    runtime: RuntimeFacts | None = None,
    now: datetime | None = None,
) -> PromptContext:
    """Resolve the per-request inputs into the record the registry renders from.

    ``now`` is injectable so tests and the settings preview can pin the clock;
    everything else mirrors :func:`build_system_prompt`.
    """
    stamp = now or datetime.now()
    spec = agent or AgentSpec()
    facts = runtime or RuntimeFacts()
    return PromptContext(
        user_name=_resolve_user_name(user_name),
        shell=shell,
        model=model,
        describe_actions=describe_actions,
        show_widget=show_widget,
        has_skills=has_skills,
        has_plugins=has_plugins,
        has_math_verify=has_math_verify,
        today=_format_today(stamp),
        now_time=f"{stamp:%H:%M}",
        os_name=facts.os_name or platform.system(),
        cwd=facts.cwd,
        tools_block=facts.tools_block,
        tool_names=facts.tool_names,
        skills_block=facts.skills_block,
        plugins_block=facts.plugins_block,
        mcp_block=facts.mcp_block,
        lang=facts.lang,
        user_persona=facts.user_persona,
        agent_memory=facts.agent_memory,
        agent_name=spec.name,
        persona=spec.persona,
        prompt_mode=spec.prompt_mode,
        disabled_modules=normalize_disabled(spec.disabled_modules),
    )


def build_prompt(ctx: PromptContext) -> PromptBuild:
    """Assemble *ctx* into text plus its provenance (modules + cache hash)."""
    return assemble(build_registry(ctx), ctx)


def build_system_prompt(
    user_name: str = "",
    shell: str = "wsl",
    model: str = "",
    describe_actions: bool = False,
    *,
    show_widget: bool = True,
    has_skills: bool = True,
    has_plugins: bool = False,
    has_math_verify: bool = True,
    agent: AgentSpec | None = None,
    runtime: RuntimeFacts | None = None,
) -> str:
    """Build the system prompt for one request.

    ``shell`` selects the bash_tool dialect ("wsl" / "powershell" / "posix" /
    "zsh"); an unknown value falls back to "wsl". ``model`` (a LiteLLM id)
    surfaces a "Model: …" line and drives the model-family quirks block.
    ``describe_actions`` mirrors the Settings toggle that adds an ``activity``
    field to tool schemas. ``show_widget`` / ``has_skills`` gate the widget and
    skills sections; both default true so existing callers are unaffected.
    ``has_plugins`` gates the Agent Plugins section and defaults *false* — an
    install with no plugins should not be told what one is.
    ``agent`` supplies a persona (appended, or replacing the built-in prompt)
    and ``runtime`` the facts its ``{…}`` variables interpolate.
    """
    ctx = make_context(
        user_name=user_name,
        shell=shell,
        model=model,
        describe_actions=describe_actions,
        show_widget=show_widget,
        has_skills=has_skills,
        has_plugins=has_plugins,
        has_math_verify=has_math_verify,
        agent=agent,
        runtime=runtime,
    )
    return build_prompt(ctx).text
