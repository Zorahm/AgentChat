"""Tests for agent personas: template variables, prompt modes, module toggles.

The old behaviour was "a non-empty agent prompt replaces everything, verbatim",
which froze the date and the shell dialect into the saved text. These cover the
replacement: a template rendered fresh every request, in one of two modes.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.prompt import variables  # noqa: E402
from agent.prompt.context import (  # noqa: E402
    APPEND_MODE,
    REPLACE_MODE,
    AgentSpec,
    PromptContext,
    RuntimeFacts,
)
from agent.prompt.modules import assemble  # noqa: E402
from agent.prompt.registry import TOGGLEABLE_MODULES, build_registry  # noqa: E402
from agent.system_prompt import (  # noqa: E402
    build_system_prompt,
    make_context,
    normalize_disabled,
)
from schemas.agents import AgentConfig, AgentUpdate, PromptMode  # noqa: E402

FACTS = RuntimeFacts(
    os_name="Windows",
    cwd="/home/u/chat-1",
    tools_block="- bash_tool — run commands\n- read_file — read a file",
    tool_names="bash_tool, read_file",
    skills_block="## Skills\n- docx",
    mcp_block="context7",
    lang="ru",
)


def ctx_with(persona: str, mode: str = APPEND_MODE, **kw: object) -> PromptContext:
    return make_context(
        user_name="Sam",
        shell="wsl",
        agent=AgentSpec(name="Pirate", persona=persona, prompt_mode=mode, **kw),  # type: ignore[arg-type]
        runtime=FACTS,
        now=datetime(2026, 7, 30, 14, 5),
    )


def render(persona: str, mode: str = APPEND_MODE, **kw: object) -> str:
    from agent.system_prompt import build_prompt

    return build_prompt(ctx_with(persona, mode, **kw)).text


# ── substitution rules ─────────────────────────────────────────────────


def test_known_variables_are_substituted() -> None:
    out = render("Call me {user}. Shell is {shell}, cwd {cwd}, lang {lang}.")
    assert "Call me Sam." in out
    assert "Shell is wsl, cwd /home/u/chat-1, lang ru." in out


def test_tools_variable_reflects_the_live_registry() -> None:
    # The whole point: {tools} is resolved per request, not captured when the
    # persona was written.
    out = render("You may use:\n{tools}")
    assert "- bash_tool — run commands" in out
    assert "- read_file — read a file" in out


def test_date_and_time_come_from_the_injected_clock() -> None:
    out = render("Today is {date}, the time is {time}.")
    assert "Today is 30 July 2026, the time is 14:05." in out


def test_persona_text_survives_the_volatile_split_verbatim() -> None:
    # The split is an internal cache optimisation; the model must see exactly
    # the paragraphs the user typed, with nothing spliced in.
    persona = "You are a pirate.\n\nToday is {date}.\n\nAlways say arr."
    out = render(persona)
    assert "You are a pirate.\n\nToday is 30 July 2026.\n\nAlways say arr." in out


def test_unknown_braces_pass_through_verbatim() -> None:
    # No escape syntax exists, so anything brace-shaped that isn't a catalog
    # name must survive byte-for-byte — otherwise a persona holding JSON or a
    # code template would be silently corrupted.
    persona = 'Reply with {"status": "ok", "n": 1} and never use {tolls} or {UPPER}.'
    out = render(persona)
    assert persona in out


def test_unknown_names_are_reported_but_not_an_error() -> None:
    assert variables.unknown_names("{tolls} and {user}") == ("tolls",)
    assert variables.used_names("{tolls} and {user}") == ("user",)


def test_used_names_are_deduped_in_first_appearance_order() -> None:
    assert variables.used_names("{shell} {user} {shell} {date}") == ("shell", "user", "date")


# ── volatility and the cache prefix ────────────────────────────────────


def test_split_volatile_cuts_on_the_paragraph_break() -> None:
    stable, volatile = variables.split_volatile("You are a pirate.\n\nToday is {date}. Arr.")
    assert stable == "You are a pirate."
    assert volatile == "Today is {date}. Arr."


def test_split_never_cuts_mid_paragraph() -> None:
    # Modules are rejoined with a blank line, so a mid-sentence cut would
    # splice one into the user's prose.
    one_para = "You are a pirate. Today is {date}. Arr."
    assert variables.split_volatile(one_para) == ("", one_para)


@pytest.mark.parametrize(
    "text",
    [
        "A\n\nB {date}",
        "A\n\n\nB {date}",
        "A\n\n\n\nB {date}",
        "A\n\nB\n\nC {time} D",
        "{model} at the very start",
        "no variables at all",
    ],
)
def test_split_then_rejoin_is_lossless(text: str) -> None:
    stable, volatile = variables.split_volatile(text)
    rejoined = "\n\n".join(p for p in (stable, volatile) if p)
    assert rejoined == text


def test_persona_without_volatile_vars_stays_whole() -> None:
    assert variables.split_volatile("Just a pirate.") == ("Just a pirate.", "")
    assert not variables.is_volatile("Just a pirate. {tools} {shell}")


def test_persona_opening_with_time_is_entirely_uncacheable() -> None:
    assert variables.split_volatile("{time} — be brief.") == ("", "{time} — be brief.")


def test_stable_persona_joins_the_cached_prefix() -> None:
    # A plain persona must not cost caching: two requests on different days
    # still share a prefix, and that prefix now includes the persona.
    def prefix(day: str) -> str:
        c = ctx_with("You are a pirate.")
        c = PromptContext(**{**c.__dict__, "today": day})
        return assemble(build_registry(c), c).cache_prefix_hash

    assert prefix("01 January 2026") == prefix("31 December 2026")


def test_volatile_persona_text_leaves_the_cached_prefix() -> None:
    stable_ctx = ctx_with("You are a pirate. Speak plainly.")
    volatile_ctx = ctx_with("You are a pirate.\n\nToday is {date}.")
    stable_build = assemble(build_registry(stable_ctx), stable_ctx)
    volatile_build = assemble(build_registry(volatile_ctx), volatile_ctx)
    # The dated half renders in the non-cacheable slot…
    assert "persona_volatile" in volatile_build.active_modules
    assert "persona_volatile" not in stable_build.active_modules
    # …but the sentence before it is still cached.
    assert "persona" in volatile_build.active_modules
    assert "30 July 2026" in volatile_build.text


def test_real_registry_with_persona_keeps_the_cache_invariant() -> None:
    for mode in (APPEND_MODE, REPLACE_MODE):
        for persona in ("plain", "{time} first", "mid {date} way", ""):
            c = ctx_with(persona, mode)
            assemble(build_registry(c), c)  # raises if the invariant breaks


# ── append mode ────────────────────────────────────────────────────────


def test_append_keeps_the_builtin_contract() -> None:
    out = render("You are a pirate. Say arr.")
    assert "## Sandbox" in out
    assert "## Tools" in out
    assert "You are AgentChat" in out
    assert "You are a pirate. Say arr." in out


def test_append_puts_the_persona_after_the_builtins_and_before_the_tail() -> None:
    out = render("ARR-MARKER")
    assert out.index("## Sandbox") < out.index("ARR-MARKER") < out.index("Date: 30 July 2026")


def test_empty_persona_changes_nothing() -> None:
    assert render("") == render("   ")
    assert "You are AgentChat" in render("")


# ── replace mode ───────────────────────────────────────────────────────


def test_replace_drops_the_builtin_prompt() -> None:
    out = render("You are a pirate. Nothing else.", REPLACE_MODE)
    assert out == "You are a pirate. Nothing else."
    assert "## Sandbox" not in out


def test_replace_can_pull_the_base_back_in() -> None:
    out = render("PREFIX\n{base}\nSUFFIX", REPLACE_MODE)
    assert out.startswith("PREFIX")
    assert out.endswith("SUFFIX")
    assert "## Sandbox" in out
    assert "You are AgentChat" in out
    # {base} is the built-in prompt *without* the tail — a replace-mode persona
    # decides for itself whether the date belongs, via {date}.
    assert "Date:" not in out


def test_replace_can_pull_a_single_block() -> None:
    out = render("Rules:\n{block:sandbox}\nEnd.", REPLACE_MODE)
    assert "## Sandbox" in out
    assert "## Wellbeing & crisis support" not in out


def test_unknown_block_renders_empty_rather_than_failing() -> None:
    out = render("A{block:no_such_module}B", REPLACE_MODE)
    assert out == "AB"


def test_replace_with_blank_persona_falls_back_to_the_builtin() -> None:
    # An agent switched to replace mode but left empty must not produce an
    # empty system prompt — that would strip every rule with no warning.
    out = render("   ", REPLACE_MODE)
    assert "You are AgentChat" in out
    assert "## Sandbox" in out


# ── module toggles ─────────────────────────────────────────────────────


def test_disabling_a_toggleable_module_removes_its_section() -> None:
    out = render("p", disabled_modules=frozenset({"crisis"}))
    assert "## Wellbeing & crisis support" not in out
    assert "## Sandbox" in out


def test_load_bearing_modules_cannot_be_disabled() -> None:
    # Someone hand-editing settings.json (or a renamed module) must not be able
    # to strip the sandbox rules while the agent still looks configured.
    assert normalize_disabled({"sandbox", "tools", "identity", "tail"}) == frozenset()
    out = render("p", disabled_modules=frozenset({"sandbox"}))
    assert "## Sandbox" in out


def test_toggleable_list_is_all_real_module_names() -> None:
    names = {m.name for m in build_registry(ctx_with(""))}
    assert set(TOGGLEABLE_MODULES) <= names


def test_half_prompt_modules_are_not_toggleable() -> None:
    # Both have a runtime half an agent-level prompt switch cannot reach: the
    # `activity` field injected into tool schemas, and the skills manifest the
    # loop appends. Dropping only the prose would leave the model holding
    # something it was never told how to use, so they live with their runtime
    # half (Settings -> Appearance, and the Skills tab) instead.
    assert "describe_actions" not in TOGGLEABLE_MODULES
    assert "skills" not in TOGGLEABLE_MODULES
    out = render("p", disabled_modules=frozenset({"describe_actions", "skills"}))
    assert "## Skills" in out


def test_disabled_modules_also_apply_to_base_expansion() -> None:
    out = render("{base}", REPLACE_MODE, disabled_modules=frozenset({"crisis"}))
    assert "## Wellbeing & crisis support" not in out
    assert "## Sandbox" in out


# ── schema/renderer agreement ──────────────────────────────────────────


def test_prompt_mode_literal_matches_the_renderer_constants() -> None:
    # schemas/ is a leaf and can't import the renderer, so the two spellings of
    # these modes are kept in step here instead.
    from typing import get_args

    assert set(get_args(PromptMode)) == {APPEND_MODE, REPLACE_MODE}


def test_blank_name_patch_is_rejected() -> None:
    # Without bounds on AgentUpdate.name this saved fine, then failed
    # validation on the next load — the agent vanished after a restart.
    with pytest.raises(ValueError):
        AgentUpdate(name="")
    assert AgentUpdate(name="ok").name == "ok"
    assert AgentUpdate().name is None


def test_agent_defaults_to_append_mode() -> None:
    assert AgentConfig(id="a", name="A").prompt_mode == APPEND_MODE


def test_legacy_agent_without_mode_migrates_to_replace() -> None:
    # Pre-modes records meant "replace"; defaulting them to append would
    # silently change what every existing agent does.
    from store.settings_store import _migrate_agent

    assert _migrate_agent({"id": "a", "name": "A", "system_prompt": "custom"})["prompt_mode"] == "replace"
    assert _migrate_agent({"id": "a", "name": "A", "system_prompt": ""})["prompt_mode"] == "append"
    assert _migrate_agent({"id": "a", "name": "A", "prompt_mode": "append"})["prompt_mode"] == "append"


# ── the wrapper still behaves ──────────────────────────────────────────


def test_agentless_prompt_is_unchanged() -> None:
    out = build_system_prompt("Sam", "wsl", "", False)
    assert out.startswith("You are AgentChat")
    assert "## Sandbox" in out
    assert "\n\n\n" not in out
