"""System prompt entry point — a thin wrapper over the module registry.

The body now lives in :mod:`agent.prompt` (a registry of :class:`PromptModule`
records). This module only gathers the per-request dynamic inputs (resolved
user name, current day) into a :class:`PromptContext` and assembles them, so the
long-standing ``build_system_prompt`` signature keeps working for callers.
"""

from __future__ import annotations

import os
from datetime import datetime

from agent.prompt.context import PromptContext
from agent.prompt.modules import assemble
from agent.prompt.registry import build_registry


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


def build_system_prompt(
    user_name: str = "",
    shell: str = "wsl",
    model: str = "",
    describe_actions: bool = False,
    *,
    show_widget: bool = True,
    has_skills: bool = True,
) -> str:
    """Build the system prompt for one request.

    ``shell`` selects the bash_tool dialect ("wsl" / "powershell" / "posix" /
    "zsh"); an unknown value falls back to "wsl". ``model`` (a LiteLLM id)
    surfaces a "Model: …" line and drives the model-family quirks block.
    ``describe_actions`` mirrors the Settings toggle that adds an ``activity``
    field to tool schemas. ``show_widget`` / ``has_skills`` gate the widget and
    skills sections; both default true so existing callers are unaffected.
    """
    ctx = PromptContext(
        user_name=_resolve_user_name(user_name),
        shell=shell,
        model=model,
        describe_actions=describe_actions,
        show_widget=show_widget,
        has_skills=has_skills,
        today=_format_today(datetime.now()),
    )
    return assemble(build_registry(ctx), ctx).text
