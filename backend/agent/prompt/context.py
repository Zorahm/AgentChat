"""Inputs to system-prompt assembly, as one immutable record.

Everything a :class:`PromptModule` may branch on lives here — the values that
used to be scattered function arguments (``user_name``, ``shell``, ``model``,
``describe_actions``) plus the session-stable capability flags that gate
optional sections. Frozen so a module can never mutate the context mid-build.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PromptContext:
    """Immutable snapshot of everything the prompt registry renders from.

    Every field must be **stable within a chat session** — the registry places
    the cacheable modules that read them into the cached prefix (see
    :func:`agent.prompt.modules.assemble`). ``model`` is the one field a user
    can flip mid-session; it only feeds the non-cacheable tail and the
    model-family block, both of which are expected to change the cache key.
    """

    user_name: str = ""
    shell: str = "wsl"
    model: str = ""
    describe_actions: bool = False
    # Session-stable capability flags — never derived from conversation state,
    # so toggling them cannot shift the cache prefix mid-conversation.
    show_widget: bool = True
    has_skills: bool = True
    # Pre-formatted current day (e.g. "24 July 2026"). Injected by the caller so
    # the pure registry stays clock-free and testable; lives in the tail only.
    today: str = ""
