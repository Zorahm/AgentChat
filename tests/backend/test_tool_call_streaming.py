"""Tests for live tool-call streaming progress events.

Guards the fix where every tool (not just write_file) emits an early
``tool_start`` the instant its name is known, plus live ``tool_input`` for the
primary arg — so a bash command reads as "running", not "hung", while the model
is still typing it.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.loop import AgentLoop
from agent.write_file_stream import emit_tool_call_progress


def _tc_delta(
    index: int,
    id: str | None = None,
    name: str | None = None,
    arguments: str | None = None,
) -> SimpleNamespace:
    """Build a LiteLLM-shaped streaming tool-call delta."""
    fn = SimpleNamespace(name=name, arguments=arguments)
    return SimpleNamespace(index=index, id=id, function=fn)


def _drive(chunks: list[list[SimpleNamespace]]) -> list[dict[str, Any]]:
    """Replay tool-call delta chunks the way run_stream does, collecting events."""
    state: dict[int, dict[str, Any]] = {}
    progress: dict[str, dict[str, Any]] = {}
    events: list[dict[str, Any]] = []
    for delta_list in chunks:
        AgentLoop._accumulate_tool_call_chunks(delta_list, state)
        events.extend(emit_tool_call_progress(state, progress))
    return events


def test_bash_starts_before_command_finishes() -> None:
    """tool_start fires on the first chunk (name known), before args complete."""
    events = _drive(
        [
            [_tc_delta(0, id="call_1", name="bash_tool", arguments="")],
            [_tc_delta(0, arguments='{"command": "pip ins')],
            [_tc_delta(0, arguments='tall numpy"}')],
        ]
    )

    # First event is an early tool_start — emitted before the command exists.
    assert events[0] == {
        "type": "tool_start",
        "id": "call_1",
        "name": "bash_tool",
        "input": {},
    }
    # Exactly one tool_start; no duplicate on later chunks.
    assert sum(e["type"] == "tool_start" for e in events) == 1

    # The command streams in via tool_input, growing monotonically.
    inputs = [e["input"]["command"] for e in events if e["type"] == "tool_input"]
    assert inputs == ["pip ins", "pip install numpy"]


def test_bash_start_carries_partial_command_when_present() -> None:
    """If the first emitted chunk already has command text, the start carries it."""
    events = _drive(
        [[_tc_delta(0, id="c", name="bash_tool", arguments='{"command": "ls -')]]
    )
    assert events[0]["type"] == "tool_start"
    assert events[0]["input"] == {"command": "ls -"}


def test_write_file_path_then_content_chunks() -> None:
    """write_file regression: start on complete path, then stream content chunks."""
    events = _drive(
        [
            [_tc_delta(0, id="w", name="write_file", arguments='{"path": "/tmp/a.txt"')],
            [_tc_delta(0, arguments=', "content": "hel')],
            [_tc_delta(0, arguments='lo"}')],
        ]
    )

    starts = [e for e in events if e["type"] == "tool_start"]
    assert len(starts) == 1
    assert starts[0]["input"] == {"path": "/tmp/a.txt"}

    # write_file streams content as tool_chunk (to the artifact panel), never tool_input.
    assert not any(e["type"] == "tool_input" for e in events)
    chunks = "".join(e["content"] for e in events if e["type"] == "tool_chunk")
    assert chunks == "hello"


def test_unknown_tool_still_starts_early() -> None:
    """A tool with no primary-arg mapping still gets an instant empty start."""
    events = _drive(
        [[_tc_delta(0, id="x", name="some_future_tool", arguments='{"q": "1"}')]]
    )
    assert events == [
        {"type": "tool_start", "id": "x", "name": "some_future_tool", "input": {}}
    ]
