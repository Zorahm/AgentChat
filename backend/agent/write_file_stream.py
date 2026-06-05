"""Helpers for streaming write_file content from partial JSON argument strings.

LLMs generate tool call arguments token-by-token as a JSON string.  For
write_file the content field can be thousands of tokens long.  These helpers
parse the incomplete JSON as it arrives so we can stream live file chunks to
the UI without waiting for the full argument to accumulate.
"""

from __future__ import annotations

import re
from collections.abc import Generator
from typing import Any


# ---------------------------------------------------------------------------
# JSON string un-escaping
# ---------------------------------------------------------------------------

_SIMPLE_ESCAPES: dict[str, str] = {
    "n": "\n", "t": "\t", "r": "\r", '"': '"',
    "\\": "\\", "/": "/", "b": "\b", "f": "\f",
}


def _unescape(raw: str) -> str:
    """Unescape the body of a JSON string (no surrounding quotes)."""
    buf: list[str] = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            nc = raw[i + 1]
            if nc == "u" and i + 5 <= len(raw):
                try:
                    buf.append(chr(int(raw[i + 2 : i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    pass
            buf.append(_SIMPLE_ESCAPES.get(nc, nc))
            i += 2
        else:
            buf.append(c)
            i += 1
    return "".join(buf)


# ---------------------------------------------------------------------------
# Partial-JSON extraction
# ---------------------------------------------------------------------------

def extract_string_value(args_str: str, key: str) -> str | None:
    """Extract a *complete* JSON string value for *key* from a partial JSON blob.

    Returns None if the value is not yet complete (closing quote not seen).
    """
    pattern = rf'"{re.escape(key)}"\s*:\s*"((?:[^"\\]|\\.)*)"'
    m = re.search(pattern, args_str)
    return _unescape(m.group(1)) if m else None


def extract_partial_string(args_str: str, key: str) -> str | None:
    """Return however much of *key*'s string value has been generated so far.

    Returns None if the key has not appeared yet.
    Returns an empty string if the key is present but no characters yet.
    Stops safely at an incomplete escape sequence at a chunk boundary.
    """
    m = re.search(rf'"{re.escape(key)}"\s*:\s*"', args_str)
    if not m:
        return None

    i = m.end()
    buf: list[str] = []

    while i < len(args_str):
        c = args_str[i]
        if c == "\\":
            if i + 1 >= len(args_str):
                break  # incomplete escape at chunk boundary — stop safely
            nc = args_str[i + 1]
            if nc == "u":
                if i + 5 <= len(args_str):
                    try:
                        buf.append(chr(int(args_str[i + 2 : i + 6], 16)))
                        i += 6
                        continue
                    except ValueError:
                        pass
                else:
                    break  # incomplete \uXXXX at boundary
            buf.append(_SIMPLE_ESCAPES.get(nc, nc))
            i += 2
        elif c == '"':
            break  # closing quote — string is complete
        else:
            buf.append(c)
            i += 1

    return "".join(buf)


# ---------------------------------------------------------------------------
# Streaming event emitter
# ---------------------------------------------------------------------------

# The one string argument worth streaming live into the tool block as the model
# types it. write_file is special-cased (its ``content`` goes to the artifact
# panel as ``tool_chunk``); every other tool streams its main arg via
# ``tool_input`` so the user watches e.g. the bash command form character by
# character. Tools absent here still get an instant (empty-input) ``tool_start``.
_PRIMARY_ARG: dict[str, str] = {
    "bash_tool": "command",
    "read_file": "path",
    "edit_file": "path",
    "read_skill": "name",
    "web_search": "query",
    "web_fetch": "url",
}


def emit_tool_call_progress(
    tool_call_state: dict[int, dict[str, Any]],
    progress_state: dict[str, dict[str, Any]],
) -> Generator[dict[str, Any], None, None]:
    """Yield early ``tool_start`` / live ``tool_input`` / ``tool_chunk`` events.

    Call this after every ``_accumulate_tool_call_chunks`` invocation.
    *progress_state* is mutated to track what has been emitted per call_id.

    The point: the tool block appears in the UI the instant the model commits to
    a call — not after it finishes typing the arguments — so a long command
    reads as "working", not "hung".

    Emits, per tool call, as soon as its ``id`` and ``name`` are known:
    - ``tool_start`` once.
    - write_file → ``tool_chunk`` for each new slice of ``content``.
    - every other tool → ``tool_input`` for each new slice of its primary arg.
    """
    for entry in tool_call_state.values():
        name: str = entry["function"]["name"]
        call_id: str = entry["id"]
        # Need both the name (to label the block / pick the primary arg) and the
        # id (to address it). Providers send these in the first chunk.
        if not call_id or not name:
            continue

        args_str: str = entry["function"]["arguments"]

        if call_id not in progress_state:
            progress_state[call_id] = {"started": False, "emitted_len": 0, "input_len": 0}
        state = progress_state[call_id]

        if name == "write_file":
            # ── write_file: start once path is known, then stream content ──
            if not state["started"]:
                path = extract_string_value(args_str, "path")
                if path:
                    yield {
                        "type": "tool_start",
                        "id": call_id,
                        "name": "write_file",
                        "input": {"path": path},
                    }
                    state["started"] = True
            if state["started"]:
                content = extract_partial_string(args_str, "content")
                if content is not None:
                    prev: int = state["emitted_len"]
                    if len(content) > prev:
                        yield {
                            "type": "tool_chunk",
                            "id": call_id,
                            "content": content[prev:],
                        }
                        state["emitted_len"] = len(content)
            continue

        # ── every other tool: start immediately, stream the primary arg ──
        primary = _PRIMARY_ARG.get(name)
        if not state["started"]:
            input0: dict[str, Any] = {}
            if primary:
                partial = extract_partial_string(args_str, primary)
                if partial:
                    input0[primary] = partial
                    state["input_len"] = len(partial)
            yield {"type": "tool_start", "id": call_id, "name": name, "input": input0}
            state["started"] = True
        elif primary:
            partial = extract_partial_string(args_str, primary)
            if partial is not None and len(partial) > state["input_len"]:
                yield {"type": "tool_input", "id": call_id, "input": {primary: partial}}
                state["input_len"] = len(partial)
