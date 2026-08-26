"""Chat modes — what the composer's tab strip picks.

A mode answers the same question an agent does: *who is answering, with which
tools, at which temperature*. So it is carried as an :class:`AgentConfig` and
flows through ``resolve_agent_runtime`` unchanged — no second path through the
request, and in particular no second place where a tool whitelist has to be
enforced (that already happens twice, in ``tools.factory`` and against the
overlays in ``api.chat``, and a third would be the one that gets forgotten).

What separates a mode from an agent is ownership, not mechanism. An agent is
the user's: editable, deletable, listed. A mode is the app's: fixed, unlisted,
and chosen per chat before the first message. Maths was shipped as a preset
agent first, and that made it something you had to know to go and attach; as a
tab it is one click on an empty chat.

Because both occupy the same slot, a chat has one or the other. Composing them
would mean deciding whose system prompt wins, and the honest answer is that
they contradict: a roleplay character required to lay its replies out as
Дано / Найти / Решение / Ответ is neither the character nor a mathematician.
"""

from __future__ import annotations

from schemas.agents import AgentConfig

# The absence of a mode. Stored as the empty string in the chat record, so an
# old chat that predates modes reads as "normal" without a migration.
NORMAL_MODE = ""

MATH_MODE = "math"

# Short on purpose: the rules live in the `math` skill, which the model reads on
# demand. Duplicating them here would give two sources of truth that drift, and
# would spend the tokens on every turn instead of the mathematical ones.
_MATH_PROMPT = """You are a mathematician. Every question the user asks in this chat is a mathematics question, and you answer it as one.

Read the `math` skill with read_skill at the start of the conversation and follow it exactly — it defines how a solution is laid out, when each tool must be called, and what the verification statuses mean.

Non-negotiables, even before you have read it:
- Lay the answer out as Дано / Найти / Решение / Ответ / Проверка (in the user's language). Never answer in loose paragraphs.
- Every formula is LaTeX: `$…$` inline, `$$…$$` for display. Never write a formula out in words.
- Verify the final answer with `math_verify` before presenting it, and report honestly what came back — `partial` and `inconclusive` are not `verified`, and an `error` is not a refutation.
- Explain the method. A correct result obtained by calling a solver, with no reasoning shown, is a failed answer.
- Draw with `math_plot` rather than describing a graph in words."""


def _math_mode() -> AgentConfig:
    return AgentConfig(
        id=MATH_MODE,
        name="Math",
        color_from="#4f9dde",
        color_to="#7c6fdc",
        system_prompt=_MATH_PROMPT,
        prompt_mode="append",
        # Deliberately narrow. Web search is the dangerous one: handed it, a
        # model under pressure looks the answer up instead of working the
        # problem, and the whole verification contour is then checking someone
        # else's result. `read_skill` and `ask_user` are load-bearing — without
        # the first the skill above can never be read, and without the second an
        # ambiguous problem gets a guess rather than a question.
        allowed_tools=[
            "math_eval",
            "math_verify",
            "math_plot",
            "show_widget",
            "read_skill",
            "ask_user",
        ],
        # Creativity is a defect here. Not 0.0: several providers treat an exact
        # zero as "use my default" or reject it outright.
        temperature=0.1,
        # A mode is not a persona and keeps no memory of its own: the facts an
        # agent accumulates belong to that agent, and a mode is shared by every
        # chat that switches into it.
        memory_enabled=False,
    )


# Built fresh per call rather than held as a module constant: AgentConfig is a
# mutable Pydantic model, and a shared instance would let one request's edit
# leak into the next.
_MODES = {MATH_MODE: _math_mode}


def get_mode(mode_id: str | None) -> AgentConfig | None:
    """The config for *mode_id*, or None for the normal mode / an unknown id.

    An unknown id is treated as normal rather than as an error: it is what a
    chat saved by a newer build looks like after a downgrade, and a chat that
    still answers is better than one that refuses to open.
    """
    factory = _MODES.get((mode_id or "").strip())
    return factory() if factory else None


def mode_ids() -> tuple[str, ...]:
    """Every selectable mode id, excluding normal. Used by the UI contract test."""
    return tuple(_MODES)
