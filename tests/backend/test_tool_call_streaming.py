"""Tests for live tool-call streaming progress events.

Guards the contract every tool relies on: the block appears the instant the
model commits to a call, and the arguments then fill in character by character —
for *any* tool, not a hardcoded shortlist — so a long call reads as "working"
and the user can see what is about to run.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.loop import AgentLoop
from agent.tool_stream import emit_tool_call_progress


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


def _stream_one(name: str, args: str, step: int) -> list[dict[str, Any]]:
    """Feed one call's arguments *step* characters at a time."""
    chunks = [[_tc_delta(0, id="c1", name=name, arguments="")]]
    chunks += [[_tc_delta(0, arguments=args[i : i + step])] for i in range(0, len(args), step)]
    return _drive(chunks)


def _assembled(events: list[dict[str, Any]], key: str) -> str:
    """Rebuild an argument the way the UI does: start value plus every delta."""
    text = ""
    for e in events:
        if e["type"] == "tool_start":
            value = e["input"].get(key)
            if isinstance(value, str):
                text = value
        elif e["type"] == "tool_input_delta" and e["key"] == key:
            text += e["chunk"]
        elif e["type"] == "tool_input" and key in e["input"]:
            text = str(e["input"][key])
    return text


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
    assert _assembled(events, "command") == "pip install numpy"


def test_bash_start_carries_partial_command_when_present() -> None:
    """If the first emitted chunk already has command text, the start carries it."""
    events = _drive(
        [[_tc_delta(0, id="c", name="bash_tool", arguments='{"command": "ls -')]]
    )
    assert events[0]["type"] == "tool_start"
    assert events[0]["input"] == {"command": "ls -"}


def test_arguments_stream_as_deltas_not_whole_values() -> None:
    """Re-sending the whole value per chunk is O(n²) on the wire — the reason a
    50 KB show_widget payload used to be unstreamable."""
    events = _stream_one("show_widget", '{"title": "Chart", "html": "<p>hello</p>"}', 4)

    deltas = [e for e in events if e["type"] == "tool_input_delta"]
    assert deltas, "arguments must stream"
    assert sum(len(e["chunk"]) for e in deltas) < 60  # each character sent once
    assert _assembled(events, "html") == "<p>hello</p>"
    assert _assembled(events, "title") == "Chart"


def test_every_argument_streams_not_just_a_primary_one() -> None:
    """The old shortlist streamed one hardcoded key per tool; an unknown tool got
    nothing at all."""
    events = _stream_one(
        "mcp__notion__search", '{"query": "roadmap", "filter": "page", "limit": 5}', 3
    )

    assert _assembled(events, "query") == "roadmap"
    assert _assembled(events, "filter") == "page"
    # Non-string values arrive whole, once they parse.
    assert {"limit": 5} in [e["input"] for e in events if e["type"] == "tool_input"]


def test_nested_and_boolean_arguments_are_reported_once_parsed() -> None:
    events = _stream_one(
        "present_files", '{"paths": ["/tmp/a.md", "/tmp/b.md"], "final": true}', 5
    )

    inputs = [e["input"] for e in events if e["type"] == "tool_input"]
    assert {"paths": ["/tmp/a.md", "/tmp/b.md"]} in inputs
    assert {"final": True} in inputs


def test_streaming_is_chunk_size_independent() -> None:
    args = '{"command": "echo \\"a\\tb\\" && ls -la /tmp"}'
    expected = 'echo "a\tb" && ls -la /tmp'
    for step in (1, 2, 5, 17, 999):
        assert _assembled(_stream_one("bash_tool", args, step), "command") == expected


def test_write_file_path_then_content_chunks() -> None:
    """write_file: the path reaches the UI whole, the content as chunks."""
    events = _drive(
        [
            [_tc_delta(0, id="w", name="write_file", arguments='{"path": "/tmp/a.txt"')],
            [_tc_delta(0, arguments=', "content": "hel')],
            [_tc_delta(0, arguments='lo"}')],
        ]
    )

    starts = [e for e in events if e["type"] == "tool_start"]
    assert len(starts) == 1
    assert {"path": "/tmp/a.txt"} in [e["input"] for e in events if e["type"] == "tool_input"]

    # content goes to the artifact panel as tool_chunk, never into the tool
    # block as an argument — the block would render the whole file otherwise.
    assert not any(
        e["type"] == "tool_input_delta" and e["key"] == "content" for e in events
    )
    chunks = "".join(e["content"] for e in events if e["type"] == "tool_chunk")
    assert chunks == "hello"


def test_write_file_content_typed_before_the_path_is_not_lost() -> None:
    """The loop flushes `content[emitted_len:]` at the end of the call, so what
    was streamed must be a strict prefix — content decoded before the path
    completes is buffered, never dropped or emitted out of order."""
    events = _drive(
        [
            [_tc_delta(0, id="w", name="write_file", arguments='{"content": "abc')],
            [_tc_delta(0, arguments='def", "path": "/tmp/a.txt"}')],
        ]
    )

    starts = [e for e in events if e["type"] == "tool_start"]
    assert len(starts) == 1
    assert "".join(e["content"] for e in events if e["type"] == "tool_chunk") == "abcdef"
    # The path must reach the UI before the bytes it collects.
    path_at = next(
        i for i, e in enumerate(events) if e["type"] == "tool_input" and "path" in e["input"]
    )
    assert path_at < next(i for i, e in enumerate(events) if e["type"] == "tool_chunk")


def test_write_file_opens_as_early_as_every_other_tool() -> None:
    """The shape a buffering provider sends: delta 1 carries id + name and no
    arguments at all, delta 2 carries the entire argument string.

    Gating write_file's start on a *complete* path made its block appear only
    once the model had finished the whole call — seconds after every other
    tool's, and exactly when there was nothing left to watch.
    """
    events = _drive(
        [
            [_tc_delta(0, id="w", name="write_file", arguments="")],
            [_tc_delta(0, arguments='{"path": "/tmp/a.txt", "content": "hello"}')],
        ]
    )

    assert events[0] == {"type": "tool_start", "id": "w", "name": "write_file", "input": {}}


def test_write_file_announces_its_path_before_the_content() -> None:
    """The UI creates the live file preview from the path, so the path has to
    arrive before the bytes it is supposed to collect."""
    events = _drive(
        [
            [_tc_delta(0, id="w", name="write_file", arguments="")],
            [_tc_delta(0, arguments='{"path": "/tmp/a.txt", "content": "hello"}')],
        ]
    )

    kinds = [(e["type"], e.get("input", e.get("content"))) for e in events]
    path_at = next(i for i, (kind, data) in enumerate(kinds) if kind == "tool_input")
    chunk_at = next(i for i, (kind, _) in enumerate(kinds) if kind == "tool_chunk")
    assert path_at < chunk_at
    assert kinds[path_at][1] == {"path": "/tmp/a.txt"}


def test_unknown_tool_streams_its_arguments_too() -> None:
    """A tool nobody has ever mapped still starts early and previews its input."""
    events = _drive(
        [[_tc_delta(0, id="x", name="some_future_tool", arguments='{"q": "1"}')]]
    )
    assert events == [
        {"type": "tool_start", "id": "x", "name": "some_future_tool", "input": {"q": "1"}}
    ]


def test_a_call_without_an_id_yet_emits_nothing() -> None:
    """Providers send id + name together; until both land there is nothing to
    address an event to."""
    assert _drive([[_tc_delta(0, name="bash_tool", arguments='{"command": "ls"}')]]) == []
