"""Live tool-call streaming — partial JSON arguments turned into UI events.

The point: a tool block appears the instant the model commits to a call, and its
arguments then fill in character by character while the model types them — for
*every* tool, including MCP proxies and whatever ships next, not a hardcoded
shortlist. A long call reads as "working", and the user can see what the model
is about to do before it runs.

Event vocabulary (consumed by ``ui/src/hooks/useChats``):

``tool_start``
    Once per call, carrying whatever arguments had decoded by then.
``tool_input_delta``
    ``{key, chunk}`` — new characters of a string argument; the UI appends.
``tool_input``
    ``{input}`` — a non-string argument, once it parses. Also re-sent by the
    agent loop with the fully parsed arguments, which is the source of truth.
``tool_chunk``
    ``write_file``'s ``content`` only — it feeds the artifact panel, not the
    tool block.
"""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

from agent.partial_json import ArgProgress, ArgScanner

WRITE_FILE = "write_file"
_PATH = "path"
_CONTENT = "content"


def emit_tool_call_progress(
    tool_call_state: dict[int, dict[str, Any]],
    progress_state: dict[str, dict[str, Any]],
) -> Generator[dict[str, Any], None, None]:
    """Yield the events a batch of streamed tool-call deltas just produced.

    Call after every ``_accumulate_tool_call_chunks``. *progress_state* is
    mutated to track, per call id, what has already been emitted.
    """
    for entry in tool_call_state.values():
        name: str = entry["function"]["name"]
        call_id: str = entry["id"]
        # Need both the name (to label the block) and the id (to address it).
        # Providers send these in the first chunk of a call.
        if not call_id or not name:
            continue

        state = progress_state.setdefault(call_id, _new_state())
        scanner: ArgScanner = state["scanner"]
        progress = scanner.feed(entry["function"]["arguments"])

        if name == WRITE_FILE:
            yield from _emit_write_file(call_id, scanner, progress, state)
        else:
            yield from _emit_generic(call_id, name, scanner, progress, state)


def _new_state() -> dict[str, Any]:
    return {
        "started": False,
        # How much write_file content went out as tool_chunk — the agent loop
        # flushes the remainder from the parsed arguments once the call closes.
        "emitted_len": 0,
        "pending": "",
        "path_sent": False,
        "scanner": ArgScanner(),
    }


def _emit_generic(
    call_id: str,
    name: str,
    scanner: ArgScanner,
    progress: ArgProgress,
    state: dict[str, Any],
) -> Generator[dict[str, Any], None, None]:
    """Start the block immediately, then stream every argument as it is typed."""
    if not state["started"]:
        # The start carries everything decoded so far (possibly a half-typed
        # string); the deltas below continue from exactly there.
        yield {"type": "tool_start", "id": call_id, "name": name, "input": dict(scanner.values)}
        state["started"] = True
        return

    for key, chunk in progress.text:
        yield {"type": "tool_input_delta", "id": call_id, "key": key, "chunk": chunk}
    for key, value in progress.done:
        yield {"type": "tool_input", "id": call_id, "input": {key: value}}


def _emit_write_file(
    call_id: str,
    scanner: ArgScanner,
    progress: ArgProgress,
    state: dict[str, Any],
) -> Generator[dict[str, Any], None, None]:
    """Open the block at once; route ``content`` to the artifact panel.

    ``content`` is the one argument that does not belong in the tool block — it
    goes to the live file preview as ``tool_chunk``. The UI builds that preview
    from the path, so the path is announced on its own the moment it is whole,
    and content decoded before then is buffered rather than dropped: the loop's
    end-of-call flush assumes what went out is a strict prefix.

    The start is NOT held back until the path parses. Providers that buffer tool
    calls (LM Studio and other local OpenAI-compatible servers) deliver id and
    name in one delta and the entire argument string in the next — waiting for a
    complete path there meant write_file's block appeared only once the model
    had finished writing, seconds after every other tool's.
    """
    if not state["started"]:
        yield {"type": "tool_start", "id": call_id, "name": WRITE_FILE, "input": {}}
        state["started"] = True

    # The path (and anything else that isn't content) types out live, exactly
    # like any other tool's arguments.
    for key, chunk in progress.text:
        if key != _CONTENT:
            yield {"type": "tool_input_delta", "id": call_id, "key": key, "chunk": chunk}

    if not state["path_sent"]:
        path = scanner.completed_value(_PATH)
        if path is not None:
            yield {"type": "tool_input", "id": call_id, "input": {_PATH: path}}
            state["path_sent"] = True

    content = "".join(chunk for key, chunk in progress.text if key == _CONTENT)
    if state["path_sent"]:
        content, state["pending"] = state["pending"] + content, ""
        if content:
            yield {"type": "tool_chunk", "id": call_id, "content": content}
            state["emitted_len"] += len(content)
    else:
        state["pending"] += content

    for key, value in progress.done:
        if key != _CONTENT:
            yield {"type": "tool_input", "id": call_id, "input": {key: value}}
