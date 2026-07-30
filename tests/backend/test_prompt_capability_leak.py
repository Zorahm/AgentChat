"""The prompt must not document capabilities the agent doesn't have.

The bug this guards: a roleplay agent (`tool_policy="memory_only"`, persona in
replace mode) still got the full skills manifest and the working-directory line
appended to its system message. Its 47-character persona was outweighed 1:117
by a catalogue it had no tool to read — whose first entry describes "AgentChat
itself, the app they are using right now" — plus a path with "AgentChat" in it.
The character duly introduced itself as AgentChat.

So the rule: a block that documents a tool ships only when that tool does.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.config import AgentConfig  # noqa: E402
from agent.loop import AgentLoop  # noqa: E402
from agent.sandbox import SandboxPolicy  # noqa: E402
from skills.reader import AgentSkillsReader  # noqa: E402
from store.memory_store import MemoryStore, render_core_block  # noqa: E402
from schemas.memory import MemoryCreate  # noqa: E402
from tools.factory import build_tool_registry  # noqa: E402


@pytest.fixture
def reader(tmp_path: Path) -> AgentSkillsReader:
    return AgentSkillsReader(tmp_path / "skills")


@pytest.fixture
def memory(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory.db")


def _loop(registry, system_prompt: str = "Ты — Герман.") -> AgentLoop:
    loop = AgentLoop(
        config=AgentConfig(model="test/model", system_prompt=system_prompt),
        tools=registry,
        llm=SimpleNamespace(),  # type: ignore[arg-type]  — _build_messages never calls it
    )
    loop.set_policy(SandboxPolicy(chat_dir=Path("/home/u/AgentChat/chats/x"), unrestricted=True))
    return loop


def _system(loop: AgentLoop) -> str:
    return str(loop._build_messages()[0]["content"])


# ── the skills manifest ──────────────────────────────────────────────────


def test_a_roleplay_agent_is_not_handed_the_skills_catalogue(
    reader: AgentSkillsReader, memory: MemoryStore
) -> None:
    registry = build_tool_registry(
        reader, tool_policy="memory_only", memory_store=memory, agent_id="rp"
    )
    loop = _loop(registry)

    loop.set_manifest("### Installed skills\n- **agentchat**: the app you are using")

    assert "agentchat" not in _system(loop)


def test_an_ordinary_agent_still_gets_the_skills_catalogue(
    reader: AgentSkillsReader,
) -> None:
    loop = _loop(build_tool_registry(reader))

    loop.set_manifest("### Installed skills\n- **agentchat**: the app you are using")

    assert "Installed skills" in _system(loop)


# ── the working directory ────────────────────────────────────────────────


def test_an_agent_with_no_file_tools_is_not_told_its_working_directory(
    reader: AgentSkillsReader, memory: MemoryStore
) -> None:
    """The path itself carries the product name — a character reading
    '/home/u/AgentChat/chats/x' concludes it lives in an app called AgentChat."""
    registry = build_tool_registry(
        reader, tool_policy="memory_only", memory_store=memory, agent_id="rp"
    )

    assert "AgentChat" not in _system(_loop(registry))


def test_an_ordinary_agent_is_still_told_its_working_directory(
    reader: AgentSkillsReader,
) -> None:
    assert "Current working directory" in _system(_loop(build_tool_registry(reader)))


# ── the memory block's own wording ───────────────────────────────────────


def test_the_memory_block_names_recall_only_when_recall_exists(
    memory: MemoryStore,
) -> None:
    memory.add("rp", MemoryCreate(text="Зовут Аня"))
    facts = memory.core("rp")

    with_tools = render_core_block(facts, has_search=True)
    without = render_core_block(facts, has_search=False)

    assert "recall" in with_tools
    assert "recall" not in without
    assert "Зовут Аня" in without
