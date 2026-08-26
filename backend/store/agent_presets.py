"""Agent presets shipped with the app, seeded once per install.

Seeded *once*, not reasserted on every boot: a preset the user deleted must
stay deleted, and one they edited must keep their edits. ``SettingsStore``
records which preset ids it has already introduced (``seeded_agents`` in
settings.json), so this file can grow a new preset later without resurrecting
the ones somebody threw away.

A preset is an ordinary agent. Nothing here is privileged — the user can rename
it, repoint its model, widen its tool list or delete it outright.

The set is currently empty. Maths shipped here first and has since become a
*mode* (``agent.modes``), reachable from the composer's tab strip instead of
by knowing to go and attach an agent. ``retired_preset_ids`` below is what
retires the old copy from installs that already have it.
"""

from __future__ import annotations

from schemas.agents import AgentConfig

MATH_AGENT_ID = "math"


def builtin_presets() -> dict[str, AgentConfig]:
    """Every shipped preset, by id."""
    return {}


def retired_preset_ids() -> tuple[str, ...]:
    """Presets this build no longer ships, whose stored copies should go.

    Only an *untouched* copy is removed — see
    :meth:`SettingsStore._retire_presets`. A preset the user edited stopped
    being ours the moment they changed it, and deleting their work to tidy up
    our own catalogue is not a trade we get to make on their behalf.
    """
    return (MATH_AGENT_ID,)


def retired_preset(agent_id: str) -> AgentConfig | None:
    """The exact config a retired preset shipped with, for the untouched check."""
    if agent_id == MATH_AGENT_ID:
        return _math_agent()
    return None


# Kept verbatim, not re-derived from agent.modes. The two happen to agree today,
# which is exactly the trap: the mode is live and will be tuned, and the moment
# it is, every untouched preset on disk would stop matching and be read as
# edited — left behind forever, by a change that had nothing to do with it. This
# copy is frozen because it describes what is *on disk*, not what we now think
# maths should be.
_MATH_PROMPT = """You are a mathematician. Every question the user asks in this chat is a mathematics question, and you answer it as one.

Read the `math` skill with read_skill at the start of the conversation and follow it exactly — it defines how a solution is laid out, when each tool must be called, and what the verification statuses mean.

Non-negotiables, even before you have read it:
- Lay the answer out as Дано / Найти / Решение / Ответ / Проверка (in the user's language). Never answer in loose paragraphs.
- Every formula is LaTeX: `$…$` inline, `$$…$$` for display. Never write a formula out in words.
- Verify the final answer with `math_verify` before presenting it, and report honestly what came back — `partial` and `inconclusive` are not `verified`, and an `error` is not a refutation.
- Explain the method. A correct result obtained by calling a solver, with no reasoning shown, is a failed answer.
- Draw with `math_plot` rather than describing a graph in words."""


def _math_agent() -> AgentConfig:
    return AgentConfig(
        id=MATH_AGENT_ID,
        name="Math",
        color_from="#4f9dde",
        color_to="#7c6fdc",
        system_prompt=_MATH_PROMPT,
        prompt_mode="append",
        allowed_tools=[
            "math_eval",
            "math_verify",
            "math_plot",
            "show_widget",
            "read_skill",
            "ask_user",
        ],
        temperature=0.1,
    )
