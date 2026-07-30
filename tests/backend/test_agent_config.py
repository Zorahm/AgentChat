"""Tests for the agent record: RP fields, tool policy, and patch semantics.

The defaults matter as much as the new fields — every existing agent in a
user's settings.json is loaded through the same model, and a default that
isn't "behave exactly as before" silently rewrites what their agents do.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.agents import AgentConfig, AgentCreate, AgentUpdate  # noqa: E402
from store.settings_store import SettingsStore  # noqa: E402


@pytest.fixture
def store(tmp_path: Path) -> SettingsStore:
    return SettingsStore(settings_path=tmp_path / "settings.json")


def _create(**kw: object) -> AgentCreate:
    return AgentCreate(id=kw.pop("id", "rp"), name=kw.pop("name", "Герман"), **kw)  # type: ignore[arg-type]


# ── defaults ─────────────────────────────────────────────────────────────


def test_a_plain_agent_keeps_todays_behaviour(store: SettingsStore) -> None:
    agent = store.add_agent(_create())

    assert agent.tool_policy == "full"
    assert agent.memory_enabled is False
    assert agent.user_persona == ""
    assert agent.greeting == ""
    assert agent.temperature is None
    assert agent.model == ""


# ── round-tripping ───────────────────────────────────────────────────────


def test_add_agent_persists_every_rp_field(store: SettingsStore) -> None:
    agent = store.add_agent(
        _create(
            tool_policy="memory_only",
            memory_enabled=True,
            user_persona="Я — Аня, ветеринар",
            greeting="*поднимает глаза* А, это ты.",
            temperature=1.05,
            model="anthropic/claude-opus-5",
        )
    )

    assert agent.tool_policy == "memory_only"
    assert agent.memory_enabled is True
    assert agent.user_persona == "Я — Аня, ветеринар"
    assert agent.greeting == "*поднимает глаза* А, это ты."
    assert agent.temperature == 1.05
    assert agent.model == "anthropic/claude-opus-5"


def test_rp_fields_survive_a_reload(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    SettingsStore(settings_path=path).add_agent(
        _create(memory_enabled=True, greeting="привет", temperature=1.1)
    )

    reloaded = SettingsStore(settings_path=path).get_agent("rp")

    assert reloaded is not None
    assert reloaded.memory_enabled is True
    assert reloaded.greeting == "привет"
    assert reloaded.temperature == 1.1


# ── patch semantics ──────────────────────────────────────────────────────


def test_update_leaves_unmentioned_fields_alone(store: SettingsStore) -> None:
    store.add_agent(_create(greeting="привет", memory_enabled=True))

    updated = store.update_agent("rp", AgentUpdate(name="Герман II"))

    assert updated.name == "Герман II"
    assert updated.greeting == "привет"
    assert updated.memory_enabled is True


def test_update_can_clear_temperature_back_to_the_global_one(store: SettingsStore) -> None:
    store.add_agent(_create(temperature=1.1))

    updated = store.update_agent("rp", AgentUpdate(temperature=None))

    assert updated.temperature is None


def test_update_rejects_a_null_name(store: SettingsStore) -> None:
    store.add_agent(_create())

    with pytest.raises(ValueError):
        store.update_agent("rp", AgentUpdate(name=None))


# ── the one cross-field rule ─────────────────────────────────────────────


def test_memory_only_without_memory_is_refused(store: SettingsStore) -> None:
    with pytest.raises(ValidationError):
        AgentConfig(id="rp", name="Герман", tool_policy="memory_only")


def test_update_cannot_strand_a_memory_only_agent_without_memory(
    store: SettingsStore,
) -> None:
    store.add_agent(_create(tool_policy="memory_only", memory_enabled=True))

    with pytest.raises(ValueError):
        store.update_agent("rp", AgentUpdate(memory_enabled=False))


def test_temperature_outside_the_sampling_range_is_refused() -> None:
    with pytest.raises(ValidationError):
        AgentConfig(id="rp", name="Герман", temperature=3.0)
