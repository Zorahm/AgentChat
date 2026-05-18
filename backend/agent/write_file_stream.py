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


def extract_partial_content(args_str: str) -> str | None:
    """Return however much of the 'content' value has been generated so far.

    Returns None if the 'content' key has not appeared yet.
    Returns an empty string if the key is present but no characters yet.
    Stops safely at an incomplete escape sequence at a chunk boundary.
    """
    m = re.search(r'"content"\s*:\s*"', args_str)
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

def emit_write_file_chunks(
    tool_call_state: dict[int, dict[str, Any]],
    wf_state: dict[str, dict[str, Any]],
) -> Generator[dict[str, Any], None, None]:
    """Yield early ``tool_start`` and incremental ``tool_chunk`` SSE events.

    Call this after every ``_accumulate_tool_call_chunks`` invocation.
    *wf_state* is mutated to track what has already been emitted per call_id.

    Emits:
    - ``tool_start`` once, as soon as the ``path`` argument is complete.
    - ``tool_chunk`` for each new slice of the ``content`` argument.
    """
    for entry in tool_call_state.values():
        if entry["function"]["name"] != "write_file":
            continue

        call_id: str = entry["id"]
        if not call_id:
            continue

        args_str: str = entry["function"]["arguments"]

        if call_id not in wf_state:
            wf_state[call_id] = {"started": False, "emitted_len": 0}

        state = wf_state[call_id]

        # ── Emit tool_start as soon as path is known ──────────────────────
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

        # ── Stream content chunks ─────────────────────────────────────────
        if state["started"]:
            content = extract_partial_content(args_str)
            if content is not None:
                prev: int = state["emitted_len"]
                if len(content) > prev:
                    yield {
                        "type": "tool_chunk",
                        "id": call_id,
                        "content": content[prev:],
                    }
                    state["emitted_len"] = len(content)
