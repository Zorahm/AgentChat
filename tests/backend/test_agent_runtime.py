"""Tests for what an attached agent contributes to one chat request.

These decisions used to be inline in ``api.chat`` where nothing could reach
them without a live LLM — which is why they are a separate function now. Each
one is a place where getting it backwards is silent: a character answering on
the wrong model, memory printed twice, or a roleplay agent quietly handed the
web.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.agent_runtime import resolve_agent_runtime  # noqa: E402
from schemas.agents import AgentConfig  # noqa: E402
from schemas.memory import MemoryCreate  # noqa: E402
from store.memory_store import MemoryStore  # noqa: E402


@pytest.fixture
def memory(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory.db")


def _agent(**kw: object) -> AgentConfig:
    return AgentConfig(id=kw.pop("id", "rp"), name=kw.pop("name", "Герман"), **kw)  # type: ignore[arg-type]


def _resolve(agent: AgentConfig | None, *, requested: str | None = None, store: MemoryStore | None = None):
    return resolve_agent_runtime(
        agent=agent,
        requested_model=requested,
        default_model="default/model",
        default_temperature=0.7,
        memory_store=store,
    )


# ── model precedence ─────────────────────────────────────────────────────


def test_an_agents_pinned_model_outranks_the_chat_header() -> None:
    runtime = _resolve(_agent(model="local/finetune"), requested="anthropic/opus")

    assert runtime.model == "local/finetune"


def test_the_chat_header_wins_when_the_agent_pins_nothing() -> None:
    assert _resolve(_agent(), requested="anthropic/opus").model == "anthropic/opus"


def test_the_default_model_is_the_last_resort() -> None:
    assert _resolve(None).model == "default/model"


# ── temperature ──────────────────────────────────────────────────────────


def test_an_agents_temperature_overrides_the_global_one() -> None:
    assert _resolve(_agent(temperature=1.05)).temperature == 1.05


def test_zero_temperature_is_an_override_not_a_missing_value() -> None:
    """`or` would treat 0.0 as absent and silently restore 0.7."""
    assert _resolve(_agent(temperature=0.0)).temperature == 0.0


def test_no_agent_temperature_falls_back_to_the_global_one() -> None:
    assert _resolve(_agent()).temperature == 0.7


# ── tool policy ──────────────────────────────────────────────────────────


def test_a_plain_agent_allows_the_overlays() -> None:
    runtime = _resolve(_agent())

    assert runtime.tool_policy == "full"
    assert runtime.allows_overlays is True


def test_memory_only_blocks_mcp_web_and_research(memory: MemoryStore) -> None:
    runtime = _resolve(
        _agent(tool_policy="memory_only", memory_enabled=True), store=memory
    )

    assert runtime.allows_overlays is False


def test_a_missing_agent_behaves_like_a_plain_one() -> None:
    runtime = _resolve(None)

    assert runtime.tool_policy == "full"
    assert runtime.memory_store is None


# ── memory wiring ────────────────────────────────────────────────────────


def test_memory_is_not_wired_for_an_agent_that_has_it_off(memory: MemoryStore) -> None:
    memory.add("rp", MemoryCreate(text="Зовут Аня"))

    runtime = _resolve(_agent(memory_enabled=False), store=memory)

    assert runtime.memory_store is None
    assert runtime.memory_block == ""
    assert runtime.appended_memory == ""


def test_memory_is_rendered_and_appended_by_default(memory: MemoryStore) -> None:
    memory.add("rp", MemoryCreate(text="Зовут Аня"))

    runtime = _resolve(_agent(memory_enabled=True), store=memory)

    assert "Зовут Аня" in runtime.memory_block
    assert runtime.appended_memory == runtime.memory_block


def test_a_persona_placing_memory_itself_suppresses_the_appended_copy(
    memory: MemoryStore,
) -> None:
    memory.add("rp", MemoryCreate(text="Зовут Аня"))

    runtime = _resolve(
        _agent(memory_enabled=True, system_prompt="Ты помнишь: {memory}"), store=memory
    )

    assert "Зовут Аня" in runtime.memory_block
    assert runtime.appended_memory == ""


def test_an_empty_memory_renders_no_block(memory: MemoryStore) -> None:
    runtime = _resolve(_agent(memory_enabled=True), store=memory)

    assert runtime.memory_block == ""


def test_memory_is_read_from_the_agents_own_shelf(memory: MemoryStore) -> None:
    memory.add("coder", MemoryCreate(text="принадлежит coder"))

    runtime = _resolve(_agent(id="rp", memory_enabled=True), store=memory)

    assert runtime.memory_block == ""
