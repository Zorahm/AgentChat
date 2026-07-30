"""Tests for the agent-memory store: dedup, the core window, and search.

The core/archive split is the load-bearing idea here — there is no second
table, "archive" is simply what falls outside the ranked window — so most of
these tests pin down exactly which facts the window admits.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.memory import MemoryCreate, MemoryUpdate  # noqa: E402
from store.memory_store import MemoryStore, render_core_block  # noqa: E402


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory.db")


def _add(store: MemoryStore, agent: str, text: str, **kw: object) -> object:
    now = kw.pop("now", None)
    return store.add(agent, MemoryCreate(text=text, **kw), now=now)  # type: ignore[arg-type]


# ── writing ──────────────────────────────────────────────────────────────


def test_add_returns_a_fact_with_an_id(store: MemoryStore) -> None:
    fact = _add(store, "rp", "Пользователя зовут Аня")

    assert fact.id > 0
    assert fact.text == "Пользователя зовут Аня"
    assert fact.agent_id == "rp"
    assert fact.pinned is False


def test_adding_the_same_text_twice_updates_instead_of_duplicating(store: MemoryStore) -> None:
    first = _add(store, "rp", "Живёт в Питере", now=100)
    second = _add(store, "rp", "Живёт в Питере", now=200)

    assert second.id == first.id
    assert second.hot_at == 200
    assert len(store.list_facts("rp")) == 1


def test_dedup_ignores_case_and_surrounding_whitespace(store: MemoryStore) -> None:
    _add(store, "rp", "Любит короткие ответы")
    _add(store, "rp", "  любит   КОРОТКИЕ ответы  ")

    assert len(store.list_facts("rp")) == 1


def test_re_adding_can_promote_a_fact_to_pinned(store: MemoryStore) -> None:
    _add(store, "rp", "Зовут Аня")
    fact = _add(store, "rp", "Зовут Аня", pinned=True)

    assert fact.pinned is True


def test_update_edits_text_and_keeps_the_id(store: MemoryStore) -> None:
    fact = _add(store, "rp", "Живёт в Питере")

    edited = store.update("rp", fact.id, MemoryUpdate(text="Живёт в Москве"))

    assert edited is not None
    assert edited.id == fact.id
    assert edited.text == "Живёт в Москве"


def test_update_of_a_foreign_agents_fact_is_refused(store: MemoryStore) -> None:
    fact = _add(store, "rp", "Зовут Аня")

    assert store.update("other", fact.id, MemoryUpdate(pinned=True)) is None


# ── the core window ──────────────────────────────────────────────────────


def test_core_orders_pinned_first_then_most_recent(store: MemoryStore) -> None:
    _add(store, "rp", "старое", now=100)
    _add(store, "rp", "свежее", now=300)
    _add(store, "rp", "закреплённое", now=200, pinned=True)

    assert [f.text for f in store.core("rp")] == ["закреплённое", "свежее", "старое"]


def test_core_stops_at_the_char_budget(store: MemoryStore) -> None:
    _add(store, "rp", "a" * 40, now=300)
    _add(store, "rp", "b" * 40, now=200)
    _add(store, "rp", "c" * 40, now=100)

    assert [f.text[0] for f in store.core("rp", char_budget=90)] == ["a", "b"]


def test_core_keeps_pinned_facts_even_past_the_budget(store: MemoryStore) -> None:
    _add(store, "rp", "p" * 40, now=100, pinned=True)
    _add(store, "rp", "q" * 40, now=200, pinned=True)
    _add(store, "rp", "r" * 40, now=300)

    texts = [f.text[0] for f in store.core("rp", char_budget=10)]

    assert texts == ["q", "p"]


def test_core_respects_max_facts(store: MemoryStore) -> None:
    for i in range(5):
        _add(store, "rp", f"факт {i}", now=100 + i)

    assert len(store.core("rp", max_facts=2)) == 2


def test_core_is_scoped_to_one_agent(store: MemoryStore) -> None:
    _add(store, "rp", "принадлежит rp")
    _add(store, "coder", "принадлежит coder")

    assert [f.text for f in store.core("rp")] == ["принадлежит rp"]


# ── search (the archive half) ────────────────────────────────────────────


def test_search_finds_a_fact_by_one_of_its_words(store: MemoryStore) -> None:
    _add(store, "rp", "Аня работает ветеринаром")
    _add(store, "rp", "Погода была скверная")

    assert [f.text for f in store.search("rp", "ветеринаром")] == ["Аня работает ветеринаром"]


def test_search_promotes_the_fact_it_returned(store: MemoryStore) -> None:
    fact = _add(store, "rp", "Аня работает ветеринаром", now=100)

    store.search("rp", "ветеринаром", now=900)

    refreshed = store.list_facts("rp")[0]
    assert refreshed.id == fact.id
    assert refreshed.hot_at == 900
    assert refreshed.hits == 1


def test_search_is_scoped_to_one_agent(store: MemoryStore) -> None:
    _add(store, "coder", "Аня работает ветеринаром")

    assert store.search("rp", "ветеринаром") == []


def test_search_falls_back_to_like_when_fts5_is_missing(store: MemoryStore) -> None:
    _add(store, "rp", "Аня работает ветеринаром")
    store._fts = False  # the PyInstaller sidecar may ship sqlite without FTS5

    assert [f.text for f in store.search("rp", "ветеринар")] == ["Аня работает ветеринаром"]


def test_a_forgotten_fact_is_no_longer_searchable(store: MemoryStore) -> None:
    fact = _add(store, "rp", "Аня работает ветеринаром")

    assert store.delete("rp", fact.id) is True
    assert store.search("rp", "ветеринаром") == []


def test_forgetting_a_foreign_agents_fact_is_refused(store: MemoryStore) -> None:
    fact = _add(store, "rp", "Зовут Аня")

    assert store.delete("other", fact.id) is False
    assert len(store.list_facts("rp")) == 1


def test_deleting_an_agent_wipes_only_its_own_memory(store: MemoryStore) -> None:
    _add(store, "rp", "принадлежит rp")
    _add(store, "coder", "принадлежит coder")

    store.delete_agent("rp")

    assert store.list_facts("rp") == []
    assert len(store.list_facts("coder")) == 1


# ── rendering ────────────────────────────────────────────────────────────


def test_render_core_block_lists_ids_and_topics(store: MemoryStore) -> None:
    _add(store, "rp", "Зовут Аня", topic="user", now=200)
    _add(store, "rp", "Идёт дождь", now=100)

    block = render_core_block(store.core("rp"))

    assert "#1 [user] Зовут Аня" in block
    assert "#2 Идёт дождь" in block
    assert "recall" in block  # points at the archive half


def test_render_core_block_is_empty_without_facts() -> None:
    assert render_core_block([]) == ""
