"""The agent tool whitelist, on both sides of the split that creates it.

``tools.factory`` builds the built-ins; ``api.chat`` builds the overlays (MCP,
web search, research, image generation). A whitelist applied to only one of them
would leave a "maths only" agent still holding the web — which is exactly what
the maths preset must not have, since a model that can look the answer up will.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.agent_runtime import resolve_agent_runtime  # noqa: E402
from schemas.agents import AgentConfig  # noqa: E402
from skills.reader import AgentSkillsReader  # noqa: E402
from tools.factory import (  # noqa: E402
    MATH_TOOL_NAMES,
    apply_whitelist,
    build_tool_registry,
)


@pytest.fixture()
def reader(tmp_path) -> AgentSkillsReader:  # type: ignore[no-untyped-def]
    return AgentSkillsReader(tmp_path / "skills")


class DummyPool:
    """The factory only needs something non-None to hand the math tools."""


def test_no_whitelist_means_unrestricted(reader: AgentSkillsReader) -> None:
    registry = build_tool_registry(reader, math_pool=DummyPool())  # type: ignore[arg-type]
    names = set(registry.list_names())
    assert "bash_tool" in names and "web_fetch" in names
    assert set(MATH_TOOL_NAMES) <= names


def test_empty_whitelist_is_unrestricted_not_empty(reader: AgentSkillsReader) -> None:
    """An empty list is how every pre-existing agent record deserialises.

    Reading it as "no tools" would silently mute every agent written before the
    field existed.
    """
    registry = build_tool_registry(reader, allowed_tools=[], math_pool=DummyPool())  # type: ignore[arg-type]
    assert "bash_tool" in registry.list_names()


def test_whitelist_keeps_only_what_it_names(reader: AgentSkillsReader) -> None:
    registry = build_tool_registry(
        reader,
        allowed_tools=["math_verify", "math_eval", "read_skill"],
        math_pool=DummyPool(),  # type: ignore[arg-type]
    )
    assert sorted(registry.list_names()) == ["math_eval", "math_verify", "read_skill"]


def test_a_stale_name_narrows_nothing_extra(reader: AgentSkillsReader) -> None:
    """A tool that no longer exists must not take a live one down with it."""
    registry = build_tool_registry(
        reader, allowed_tools=["math_verify", "tool_that_was_removed"], math_pool=DummyPool()  # type: ignore[arg-type]
    )
    assert registry.list_names() == ["math_verify"]


def test_whitelist_also_covers_the_memory_tools(reader: AgentSkillsReader, tmp_path) -> None:  # type: ignore[no-untyped-def]
    from store.memory_store import MemoryStore

    store = MemoryStore(tmp_path / "memory.db")
    registry = build_tool_registry(
        reader,
        allowed_tools=["math_verify"],
        memory_store=store,
        agent_id="a1",
        math_pool=DummyPool(),  # type: ignore[arg-type]
    )
    assert registry.list_names() == ["math_verify"]


def test_no_math_pool_means_no_math_tools(reader: AgentSkillsReader) -> None:
    """The frozen sidecar can ship without a pool wired; the roster must not lie."""
    registry = build_tool_registry(reader)
    assert not set(MATH_TOOL_NAMES) & set(registry.list_names())


def test_apply_whitelist_is_a_noop_for_none(reader: AgentSkillsReader) -> None:
    registry = build_tool_registry(reader, math_pool=DummyPool())  # type: ignore[arg-type]
    before = sorted(registry.list_names())
    apply_whitelist(registry, None)
    assert sorted(registry.list_names()) == before


# ── the overlay half ──────────────────────────────────────────────────────


def runtime_for(agent: AgentConfig | None):  # type: ignore[no-untyped-def]
    return resolve_agent_runtime(
        agent=agent,
        requested_model="m",
        default_model="m",
        default_temperature=0.7,
        memory_store=None,
    )


def test_permits_everything_without_an_agent() -> None:
    runtime = runtime_for(None)
    assert runtime.permits("web_search") and runtime.permits("research")


def test_permits_everything_with_an_empty_whitelist() -> None:
    runtime = runtime_for(AgentConfig(id="a", name="A"))
    assert runtime.permits("image_generate")


def test_a_whitelist_gates_the_overlays_too() -> None:
    """The one that matters: a maths agent must not reach for web search."""
    agent = AgentConfig(
        id="math", name="Math", allowed_tools=["math_verify", "math_eval", "math_plot"]
    )
    runtime = runtime_for(agent)
    assert runtime.permits("math_verify")
    assert not runtime.permits("web_search")
    assert not runtime.permits("research")
    assert not runtime.permits("image_generate")
    assert not runtime.permits("mcp__server__anything")


def test_the_math_mode_cannot_reach_the_web() -> None:
    """Maths shipped as a preset agent and is now a composer mode; the whitelist
    is the reason either exists, so it moved with it. Handed web search, a model
    under pressure looks the answer up, and the verification contour then checks
    somebody else's result."""
    from agent.modes import MATH_MODE, get_mode

    mode = get_mode(MATH_MODE)
    assert mode is not None
    runtime = runtime_for(mode)
    assert not runtime.permits("web_search")
    assert not runtime.permits("bash_tool")
    # read_skill is load-bearing: without it the math skill can never be read.
    assert runtime.permits("read_skill")
    assert runtime.permits("math_verify")
