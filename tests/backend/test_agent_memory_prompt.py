"""Tests for how memory and the user persona reach the prompt.

Two invariants carry real cost if they break: ``{memory}`` must be treated as
volatile (or every turn re-bills the whole cached prefix), and a persona that
places ``{memory}`` itself must not also get the block auto-appended (or the
model reads its own memory twice and starts contradicting it).
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.config import AgentConfig  # noqa: E402
from agent.loop import AgentLoop  # noqa: E402
from agent.prompt import variables  # noqa: E402
from agent.prompt.context import AgentSpec, RuntimeFacts  # noqa: E402
from agent.sandbox import SandboxPolicy  # noqa: E402
from agent.system_prompt import build_prompt, make_context  # noqa: E402
from llm.token_breakdown import estimate_prompt_breakdown  # noqa: E402
from skills.reader import AgentSkillsReader  # noqa: E402
from tools.factory import build_tool_registry  # noqa: E402
from tools.registry import ToolRegistry  # noqa: E402


def _build(persona: str, *, mode: str = "replace", memory: str = "", persona_of_user: str = ""):
    ctx = make_context(
        agent=AgentSpec(name="Герман", persona=persona, prompt_mode=mode),
        runtime=RuntimeFacts(agent_memory=memory, user_persona=persona_of_user),
    )
    return build_prompt(ctx)


# ── the variables ────────────────────────────────────────────────────────


def test_user_persona_is_substituted() -> None:
    build = _build("Собеседник: {user_persona}", persona_of_user="Аня, ветеринар")

    assert "Собеседник: Аня, ветеринар" in build.text


def test_memory_is_substituted() -> None:
    build = _build("Ты помнишь: {memory}", memory="- #1 Зовут Аня")

    assert "- #1 Зовут Аня" in build.text


def test_user_persona_stays_cacheable() -> None:
    """It cannot change between two requests of one chat."""
    assert not variables.is_volatile("Собеседник: {user_persona}")


def test_memory_is_volatile() -> None:
    """It changes the moment the model remembers anything."""
    assert variables.is_volatile("Ты помнишь: {memory}")


def test_memory_reference_is_split_out_of_the_cacheable_head() -> None:
    stable, volatile = variables.split_volatile(
        "Ты — Герман, старый смотритель маяка.\n\nТы помнишь: {memory}"
    )

    assert stable == "Ты — Герман, старый смотритель маяка."
    assert volatile == "Ты помнишь: {memory}"


def test_a_persona_without_memory_keeps_its_whole_prefix_cacheable() -> None:
    build = _build("Ты — Герман, старый смотритель маяка.", memory="- #1 Зовут Аня")

    assert "persona" in build.active_modules
    assert "persona_volatile" not in build.active_modules


# ── explicit placement wins ──────────────────────────────────────────────


def test_references_detects_an_explicit_memory_placement() -> None:
    assert variables.references("Ты помнишь: {memory}", "memory") is True


def test_references_ignores_an_unrelated_variable() -> None:
    assert variables.references("Сегодня {date}", "memory") is False


def test_references_ignores_prose_braces() -> None:
    """A persona holding JSON must not read as a variable reference."""
    assert variables.references('Отвечай как {"memory": 1}', "memory") is False


# ── where the appended block lands ───────────────────────────────────────


def _loop(system_prompt: str = "BASE", *, tools: ToolRegistry | None = None) -> AgentLoop:
    return AgentLoop(
        config=AgentConfig(model="test/model", system_prompt=system_prompt),
        tools=tools if tools is not None else ToolRegistry(),
        llm=SimpleNamespace(),  # type: ignore[arg-type]  — _build_messages never calls it
    )


def test_memory_is_appended_after_everything_else(tmp_path: Path) -> None:
    """It is the only part that changes turn to turn, so it must come last —
    anything after it would drop out of the provider's cached prefix too.

    Built on a real full registry: the skills manifest and the cwd line only
    ship when their tools do (see test_prompt_capability_leak), so an empty
    registry would leave nothing here to order.
    """
    chat_dir = Path("/chats/x")
    loop = _loop(tools=build_tool_registry(AgentSkillsReader(tmp_path / "skills")))
    loop.set_project_context("PROJECT")
    loop.set_manifest("SKILLS")
    loop.set_policy(SandboxPolicy(chat_dir=chat_dir, unrestricted=True))
    loop.set_agent_memory("MEMORY")

    system = loop._build_messages()[0]["content"]
    parts = ("BASE", "PROJECT", "SKILLS", str(chat_dir), "MEMORY")
    positions = [system.index(part) for part in parts]

    assert positions == sorted(positions)


def test_no_memory_leaves_the_system_message_untouched() -> None:
    assert _loop()._build_messages()[0]["content"] == "BASE"


def test_memory_gets_its_own_bucket_in_the_token_breakdown() -> None:
    """Folding it into the project-context bucket would report an agent's
    memory as the user's project files."""
    breakdown = estimate_prompt_breakdown(
        model="gpt-4o",
        system_prompt="system",
        project_context="project",
        agent_memory="- #1 Зовут Аня",
        skills_manifest="",
        tools=None,
        history=[],
        new_user_message=False,
    )

    assert breakdown["agent_memory"] > 0
    assert breakdown["memory"] > 0
