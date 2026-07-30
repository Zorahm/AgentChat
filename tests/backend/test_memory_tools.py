"""Tests for the remember/recall/forget tools.

Everything here goes through ``ToolRegistry.execute`` rather than calling the
tools directly: the dispatch path is what strips the ``activity`` field and
what the model actually reaches, and a tool whose signature only works when
called by hand is a tool that fails in production.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.memory import MemoryCreate  # noqa: E402
from store.memory_store import MemoryStore  # noqa: E402
from tools.memory_tools import build_memory_tools  # noqa: E402
from tools.registry import ToolRegistry  # noqa: E402


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory.db")


def _registry(store: MemoryStore, agent_id: str = "rp", chat_id: str = "chat-1") -> ToolRegistry:
    registry = ToolRegistry()
    for tool in build_memory_tools(store, agent_id=agent_id, chat_id=chat_id):
        registry.register(tool)
    return registry


# ── remember ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_remember_stores_the_fact_and_reports_its_id(store: MemoryStore) -> None:
    result = await _registry(store).execute("remember", {"text": "Зовут Аня"})

    facts = store.list_facts("rp")
    assert len(facts) == 1
    assert facts[0].text == "Зовут Аня"
    assert f"#{facts[0].id}" in result


@pytest.mark.asyncio
async def test_remember_records_which_chat_the_fact_came_from(store: MemoryStore) -> None:
    await _registry(store, chat_id="chat-7").execute("remember", {"text": "Зовут Аня"})

    assert store.list_facts("rp")[0].source_chat_id == "chat-7"


@pytest.mark.asyncio
async def test_remember_accepts_topic_and_pinned(store: MemoryStore) -> None:
    await _registry(store).execute(
        "remember", {"text": "Зовут Аня", "topic": "user", "pinned": True}
    )

    fact = store.list_facts("rp")[0]
    assert fact.topic == "user"
    assert fact.pinned is True


@pytest.mark.asyncio
async def test_remember_survives_the_activity_field(store: MemoryStore) -> None:
    """``describe_actions`` overlays `activity` onto every schema."""
    result = await _registry(store).execute(
        "remember", {"text": "Зовут Аня", "activity": "запоминаю имя"}
    )

    assert "Error" not in result
    assert len(store.list_facts("rp")) == 1


# ── recall ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recall_returns_matching_facts_with_ids(store: MemoryStore) -> None:
    store.add("rp", MemoryCreate(text="Аня работает ветеринаром"))
    store.add("rp", MemoryCreate(text="Погода была скверная"))

    result = await _registry(store).execute("recall", {"query": "ветеринаром"})

    assert "ветеринаром" in result
    assert "скверная" not in result


@pytest.mark.asyncio
async def test_recall_says_so_when_nothing_matches(store: MemoryStore) -> None:
    store.add("rp", MemoryCreate(text="Зовут Аня"))

    result = await _registry(store).execute("recall", {"query": "квантовая хромодинамика"})

    assert "Nothing" in result


@pytest.mark.asyncio
async def test_recall_cannot_read_another_agents_memory(store: MemoryStore) -> None:
    store.add("coder", MemoryCreate(text="Аня работает ветеринаром"))

    result = await _registry(store, agent_id="rp").execute("recall", {"query": "ветеринаром"})

    # The miss message quotes the query back, so assert on the verdict instead.
    assert "Nothing" in result
    assert "Аня" not in result


# ── forget ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_forget_removes_the_fact(store: MemoryStore) -> None:
    fact = store.add("rp", MemoryCreate(text="Живёт в Питере"))

    result = await _registry(store).execute("forget", {"fact_id": fact.id})

    assert store.list_facts("rp") == []
    assert "Error" not in result


@pytest.mark.asyncio
async def test_forget_of_an_unknown_id_says_so_rather_than_claiming_success(
    store: MemoryStore,
) -> None:
    result = await _registry(store).execute("forget", {"fact_id": 999})

    assert "No fact" in result


@pytest.mark.asyncio
async def test_forget_cannot_reach_another_agents_fact(store: MemoryStore) -> None:
    fact = store.add("coder", MemoryCreate(text="Живёт в Питере"))

    await _registry(store, agent_id="rp").execute("forget", {"fact_id": fact.id})

    assert len(store.list_facts("coder")) == 1
