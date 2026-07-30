"""Tests for the per-agent tool policy.

The point of ``memory_only`` is that a roleplay character never sees a tool
roster that breaks the fiction — so these assert on the exact set, not on the
absence of one or two names. A tool that sneaks back in is the whole bug.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from skills.reader import AgentSkillsReader  # noqa: E402
from store.memory_store import MemoryStore  # noqa: E402
from tools.factory import MEMORY_TOOL_NAMES, build_tool_registry  # noqa: E402


@pytest.fixture
def reader(tmp_path: Path) -> AgentSkillsReader:
    return AgentSkillsReader(tmp_path / "skills")


@pytest.fixture
def memory(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory.db")


def test_full_policy_is_unchanged_when_memory_is_off(reader: AgentSkillsReader) -> None:
    names = set(build_tool_registry(reader).list_names())

    assert "bash_tool" in names
    assert "write_file" in names
    assert names & set(MEMORY_TOOL_NAMES) == set()


def test_full_policy_adds_memory_tools_on_top(
    reader: AgentSkillsReader, memory: MemoryStore
) -> None:
    names = set(
        build_tool_registry(
            reader, tool_policy="full", memory_store=memory, agent_id="rp"
        ).list_names()
    )

    assert "bash_tool" in names
    assert set(MEMORY_TOOL_NAMES) <= names


def test_memory_only_ships_exactly_the_memory_tools(
    reader: AgentSkillsReader, memory: MemoryStore
) -> None:
    names = build_tool_registry(
        reader, tool_policy="memory_only", memory_store=memory, agent_id="rp"
    ).list_names()

    assert sorted(names) == sorted(MEMORY_TOOL_NAMES)


def test_none_policy_ships_no_tools_at_all(
    reader: AgentSkillsReader, memory: MemoryStore
) -> None:
    """Even with a memory store wired — 'none' means none."""
    registry = build_tool_registry(
        reader, tool_policy="none", memory_store=memory, agent_id="rp"
    )

    assert registry.list_names() == []


def test_memory_tools_need_a_store(reader: AgentSkillsReader) -> None:
    """memory_enabled=False reaches the factory as a missing store."""
    names = build_tool_registry(reader, tool_policy="memory_only").list_names()

    assert names == []
