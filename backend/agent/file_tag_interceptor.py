"""Intercept <file ...>...</file> and <edit ... /> tags in the LLM token stream.

Two streaming-tag operations are supported:

1. File write (block tag):

       <file path="/absolute/path/to/file">
       ...file content, unlimited lines...
       </file>

2. In-place edit (self-closing tag, attribute-only — one replacement per tag):

       <edit path="/abs/path" old="foo\\n  return 1" new="foo\\n  return 2" />

   Attribute values use JSON-style escape sequences: \\n, \\t, \\r, \\", \\\\.

This interceptor routes tokens to the correct SSE events:
  - Text outside any tag  →  token events  (shown in chat)
  - Opening/closing tags  →  token events  (stripped by frontend parseArtifacts)
  - Content inside <file> →  tool_chunk    (shown in live file preview)
  - Block boundaries      →  tool_start / tool_end

For <edit>, no streaming progress is shown — the replacement is atomic; the loop
handles it via _edit_file_from_tag once tool_end carries the _edit_path marker.
"""

from __future__ import annotations

import re
import time
from collections.abc import Generator
from typing import Any

_OPEN_RE = re.compile(r'<file\s+path="([^"]+)"[^>]*>')
_EDIT_RE = re.compile(r'<edit\s+([^>]*?)/>', re.DOTALL)
_PARTIAL_OPEN_RE = re.compile(r'<(?:file|edit)\s')
_CLOSE = "</file>"
_ATTR_RE = re.compile(r'(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"', re.DOTALL)

_ESCAPE_MAP = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}


def _decode_attr(s: str) -> str:
    """Decode JSON-style escape sequences (\\n, \\t, \\r, \\", \\\\, \\/) in attribute value."""
    out: list[str] = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            out.append(_ESCAPE_MAP.get(nxt, c + nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _parse_edit_attrs(attrs_str: str) -> dict[str, str]:
    """Parse the inside of <edit ... /> into a key→value map."""
    return {m.group(1): _decode_attr(m.group(2)) for m in _ATTR_RE.finditer(attrs_str)}


class FileTagInterceptor:
    """State machine that routes tokens from a streaming LLM response."""

    def __init__(self) -> None:
        self._buf = ""
        self._in_file = False
        self._file_path = ""
        self._file_id = ""
        self._file_content = ""  # accumulated for disk write at tag close

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def feed(self, token: str) -> Generator[dict[str, Any], None, None]:
        """Process one streaming token; yield zero or more SSE event dicts."""
        self._buf += token
        yield from self._drain()

    def flush(self) -> Generator[dict[str, Any], None, None]:
        """Call at end of stream to emit any remaining buffered text."""
        if self._buf and not self._in_file:
            yield {"type": "token", "content": self._buf}
            self._buf = ""

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _drain(self) -> Generator[dict[str, Any], None, None]:
        while self._buf:
            prev_len = len(self._buf)
            if not self._in_file:
                yield from self._drain_normal()
            else:
                yield from self._drain_file()
            # Stop if no progress (buffer at chunk boundary — need more data)
            if len(self._buf) == prev_len:
                break

    def _drain_normal(self) -> Generator[dict[str, Any], None, None]:
        # Find the earliest of <file ...> or <edit ... /> in the buffer.
        file_m = _OPEN_RE.search(self._buf)
        edit_m = _EDIT_RE.search(self._buf)

        if file_m and edit_m:
            chosen = file_m if file_m.start() <= edit_m.start() else edit_m
        else:
            chosen = file_m or edit_m

        if chosen is file_m and file_m is not None:
            yield from self._handle_file_open(file_m)
            return

        if chosen is edit_m and edit_m is not None:
            yield from self._handle_edit(edit_m)
            return

        # Tag not complete. Is there a partial "<file " or "<edit " anywhere?
        pm = _PARTIAL_OPEN_RE.search(self._buf)
        if pm:
            idx = pm.start()
            if idx > 0:
                yield {"type": "token", "content": self._buf[:idx]}
                self._buf = self._buf[idx:]
            # Hold back from the partial tag onward until it completes
            return

        # No partial tag in middle. Hold back trailing chars that could start
        # either `<file` or `<edit` (e.g. buffer ends with "<", "<e", "<edi").
        safe = _safe_end_multi(self._buf, ("<file", "<edit"))
        if safe > 0:
            yield {"type": "token", "content": self._buf[:safe]}
            self._buf = self._buf[safe:]
        # else: need more data, stop draining

    def _handle_file_open(self, m: re.Match[str]) -> Generator[dict[str, Any], None, None]:
        # Emit text before the tag as normal chat tokens
        before = self._buf[: m.start()]
        if before:
            yield {"type": "token", "content": before}

        # Emit the opening tag itself as a token (kept in history; stripped by UI)
        yield {"type": "token", "content": m.group(0) + "\n"}

        # Switch to file-capture mode
        self._file_path = m.group(1)
        self._file_id = f"ftag-{int(time.monotonic() * 1_000_000) % 10_000_000}"
        self._file_content = ""
        self._in_file = True
        self._buf = self._buf[m.end() :]

        yield {
            "type": "tool_start",
            "id": self._file_id,
            "name": "write_file",
            "input": {"path": self._file_path},
        }

    def _handle_edit(self, m: re.Match[str]) -> Generator[dict[str, Any], None, None]:
        before = self._buf[: m.start()]
        if before:
            yield {"type": "token", "content": before}

        attrs = _parse_edit_attrs(m.group(1))
        path = attrs.get("path", "")
        old = attrs.get("old", "")
        new = attrs.get("new", "")

        # Emit the raw tag so it's preserved in history (UI strips it)
        yield {"type": "token", "content": m.group(0) + "\n"}

        eid = f"etag-{int(time.monotonic() * 1_000_000) % 10_000_000}"
        yield {
            "type": "tool_start",
            "id": eid,
            "name": "edit_file",
            "input": {"path": path, "old": old, "new": new},
        }
        # Mark tool_end with _edit_path so the loop performs the on-disk edit
        # and overwrites success/output with the real result.
        yield {
            "type": "tool_end",
            "id": eid,
            "name": "edit_file",
            "success": True,
            "output": "",
            "duration_ms": 0.0,
            "_edit_path": path,
            "_edit_old": old,
            "_edit_new": new,
        }
        self._buf = self._buf[m.end():]

    def _drain_file(self) -> Generator[dict[str, Any], None, None]:
        idx = self._buf.find(_CLOSE)
        if idx >= 0:
            # Emit all content before the closing tag
            chunk = self._buf[:idx]
            if chunk:
                self._file_content += chunk
                yield {"type": "tool_chunk", "id": self._file_id, "content": chunk}

            # Emit closing tag as token (stripped by UI, kept in history)
            yield {"type": "token", "content": _CLOSE + "\n"}

            # Signal completion — loop will do the disk write
            yield {
                "type": "tool_end",
                "id": self._file_id,
                "name": "write_file",
                "success": True,
                "output": f"Written to {self._file_path}",
                "duration_ms": 0.0,
                "_path": self._file_path,
                "_content": self._file_content,
            }

            self._buf = self._buf[idx + len(_CLOSE) :]
            self._in_file = False
        else:
            # Hold back chars that could be the start of </file>
            safe = _safe_end(self._buf, _CLOSE)
            if safe > 0:
                chunk = self._buf[:safe]
                self._file_content += chunk
                yield {"type": "tool_chunk", "id": self._file_id, "content": chunk}
                self._buf = self._buf[safe:]
            # else: need more data, stop draining


def _safe_end(buf: str, tag: str) -> int:
    """Return how many chars from *buf* can be emitted without risk of cutting a *tag* prefix.

    Example: buf="hello </fi", tag="</file>" → 7  (safe to emit "hello </fi"[:7])
    """
    for n in range(min(len(tag), len(buf)), 0, -1):
        if buf.endswith(tag[:n]):
            return len(buf) - n
    return len(buf)


def _safe_end_multi(buf: str, tags: tuple[str, ...]) -> int:
    """Like _safe_end but for multiple candidate tag prefixes — returns the min safe count."""
    safe = len(buf)
    for tag in tags:
        safe = min(safe, _safe_end(buf, tag))
    return safe
