"""Tests for the agent memory CRUD routes and the greeting renderer.

The routes are called directly with a stand-in request rather than through a
TestClient: the remote-access guard treats TestClient's synthetic host as
remote and would answer 403 before any of this code ran.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.agents import (  # noqa: E402
    add_memory,
    agent_greeting,
    delete_agent,
    delete_memory,
    list_memory,
    update_memory,
)
from schemas.agents import AgentCreate  # noqa: E402
from schemas.memory import MemoryCreate, MemoryUpdate  # noqa: E402
from store.memory_store import MemoryStore  # noqa: E402
from store.settings_store import SettingsStore  # noqa: E402


@pytest.fixture
def request_stub(tmp_path: Path):
    settings = SettingsStore(settings_path=tmp_path / "settings.json")
    settings.add_agent(
        AgentCreate(
            id="rp",
            name="Герман",
            greeting="*кивает* Снова ты, {user}.",
            user_persona="Аня, ветеринар",
        )
    )
    state = SimpleNamespace(
        settings_store=settings,
        memory_store=MemoryStore(tmp_path / "memory.db"),
    )
    return SimpleNamespace(app=SimpleNamespace(state=state))


def _memory(request_stub) -> MemoryStore:
    return request_stub.app.state.memory_store


# ── CRUD ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_added_memory_comes_back_from_the_list(request_stub) -> None:
    await add_memory(request_stub, "rp", MemoryCreate(text="Зовут Аня"))

    facts = await list_memory(request_stub, "rp")

    assert [f.text for f in facts] == ["Зовут Аня"]


@pytest.mark.asyncio
async def test_memory_of_an_unknown_agent_is_404(request_stub) -> None:
    with pytest.raises(HTTPException) as exc:
        await add_memory(request_stub, "ghost", MemoryCreate(text="Зовут Аня"))

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_a_fact_can_be_pinned_through_the_api(request_stub) -> None:
    fact = await add_memory(request_stub, "rp", MemoryCreate(text="Зовут Аня"))

    updated = await update_memory(request_stub, "rp", fact.id, MemoryUpdate(pinned=True))

    assert updated.pinned is True


@pytest.mark.asyncio
async def test_editing_another_agents_fact_is_404(request_stub) -> None:
    fact = _memory(request_stub).add("other", MemoryCreate(text="чужое"))

    with pytest.raises(HTTPException) as exc:
        await update_memory(request_stub, "rp", fact.id, MemoryUpdate(pinned=True))

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_deleting_a_fact_removes_it(request_stub) -> None:
    fact = await add_memory(request_stub, "rp", MemoryCreate(text="Зовут Аня"))

    await delete_memory(request_stub, "rp", fact.id)

    assert await list_memory(request_stub, "rp") == []


@pytest.mark.asyncio
async def test_deleting_an_agent_takes_its_memory_with_it(request_stub) -> None:
    """Memory outlives chats, not the agent it belongs to — a re-created id
    must not inherit the deleted persona's recollections."""
    await add_memory(request_stub, "rp", MemoryCreate(text="Зовут Аня"))

    await delete_agent(request_stub, "rp")

    assert _memory(request_stub).list_facts("rp") == []


# ── greeting ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_greeting_is_rendered_with_variables_substituted(request_stub) -> None:
    request_stub.app.state.settings_store.update(_user_name("Аня"))

    result = await agent_greeting(request_stub, "rp")

    assert result.text == "*кивает* Снова ты, Аня."


@pytest.mark.asyncio
async def test_an_agent_without_a_greeting_returns_empty(request_stub) -> None:
    request_stub.app.state.settings_store.add_agent(AgentCreate(id="mute", name="Тихий"))

    result = await agent_greeting(request_stub, "mute")

    assert result.text == ""


@pytest.mark.asyncio
async def test_greeting_of_an_unknown_agent_is_404(request_stub) -> None:
    with pytest.raises(HTTPException) as exc:
        await agent_greeting(request_stub, "ghost")

    assert exc.value.status_code == 404


def _user_name(name: str):
    from schemas.settings import SettingsUpdate

    return SettingsUpdate(user_name=name)
