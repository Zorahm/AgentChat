"""Intercept <file ...>...</file> and <edit ...> tags in the LLM token stream.

Three streaming-tag operations are supported:

1. File write (block tag):

       <file path="/absolute/path/to/file">
       ...file content, unlimited lines...
       </file>

2. In-place edit, self-closing form (short edits, one line each):

       <edit path="/abs/path" old="foo\\n  return 1" new="foo\\n  return 2" />

   Attribute values use JSON-style escapes (\\n, \\t, \\r, \\", \\\\).

3. In-place edit, block form (multi-line edits — preferred for >1 line):

       <edit path="/abs/path">
       <old>
       def proces_data(items):
           total = 0
           for x in items:
       </old>
       <new>
       def process_data(items):
           total = 0
           for x in items:
       </new>
       </edit>

   One leading and one trailing newline are stripped from the inner content
   of <old> / <new>, so the example above matches the literal three lines.

This interceptor routes tokens to the correct SSE events:
  - Text outside any tag       →  token events  (shown in chat)
  - Opening/closing tags       →  token events  (stripped by frontend parser)
  - Content inside <file>      →  tool_chunk    (shown in live file preview)
  - <edit> markers             →  tool_start / tool_end with _edit_path
  - Block boundaries           →  tool_start / tool_end

For <edit>, no live progress is shown — the replacement is atomic; the loop
handles it via _edit_file_from_tag once tool_end carries the _edit_path marker.
"""

from __future__ import annotations

import re
import time
from collections.abc import Generator
from typing import Any

_OPEN_RE = re.compile(r'<file\s+path="([^"]+)"[^>]*>')
# Self-closing <edit ... />. Negative lookbehind is implicit via the trailing /.
_EDIT_SELF_RE = re.compile(r'<edit\s+([^>]*?)/>', re.DOTALL)
# Block-form opening <edit path="..."> WITHOUT a trailing slash. We disallow `/`
# in the attribute span so the self-closing form doesn't accidentally match.
_EDIT_OPEN_RE = re.compile(r'<edit\s+(path\s*=\s*"[^"]*"(?:\s+[^/>]*?)?)\s*>')
_EDIT_CLOSE = "</edit>"
_OLD_RE = re.compile(r'<old>([\s\S]*?)</old>')
_NEW_RE = re.compile(r'<new>([\s\S]*?)</new>')

_PARTIAL_OPEN_RE = re.compile(r'<(?:file|edit)\s')
_FILE_CLOSE = "</file>"
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


def _parse_attrs(attrs_str: str) -> dict[str, str]:
    """Parse `key="value"` pairs into a map. Used for both <edit /> and <edit>."""
    return {m.group(1): _decode_attr(m.group(2)) for m in _ATTR_RE.finditer(attrs_str)}


def _strip_edge_newline(s: str) -> str:
    """Strip exactly one leading and one trailing newline (with optional \\r).

    Makes the block form ergonomic: the model puts the content on a new line
    after <old> / before </old>, and we don't carry that boundary newline
    into the actual literal text.
    """
    if s.startswith("\r\n"):
        s = s[2:]
    elif s.startswith("\n"):
        s = s[1:]
    if s.endswith("\r\n"):
        s = s[:-2]
    elif s.endswith("\n"):
        s = s[:-1]
    return s


def _is_absolute_path(path: str) -> bool:
    """Allow WSL ("/…") and Windows drive paths ("C:\\…" or "C:/…")."""
    if not path:
        return False
    if path.startswith("/"):
        return True
    return len(path) >= 3 and path[1] == ":" and path[2] in ("\\", "/")


class FileTagInterceptor:
    """State machine that routes tokens from a streaming LLM response."""

    def __init__(self) -> None:
        self._buf = ""
        # <file>
        self._in_file = False
        self._file_path = ""
        self._file_id = ""
        self._file_content = ""
        # <edit>...</edit> block
        self._in_edit_block = False
        self._edit_path = ""
        self._edit_id = ""
        self._edit_body = ""  # accumulated inner text between opening and </edit>

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def feed(self, token: str) -> Generator[dict[str, Any], None, None]:
        """Process one streaming token; yield zero or more SSE event dicts."""
        self._buf += token
        yield from self._drain()

    def flush(self) -> Generator[dict[str, Any], None, None]:
        """Call at end of stream to emit any remaining buffered text.

        If the stream ended mid-<file> or mid-<edit>, emit a failed tool_end
        so the UI shows an error instead of hanging on the in-flight tool.
        """
        if self._in_file:
            # Flush whatever was captured so the file preview shows partial content,
            # then mark the write as failed — the loop will skip the on-disk write
            # because we strip the _path / _content markers.
            yield {
                "type": "tool_end",
                "id": self._file_id,
                "name": "write_file",
                "success": False,
                "output": (
                    f"Error: <file> tag for '{self._file_path}' was never closed "
                    f"with </file>. {len(self._file_content)} chars captured but "
                    "NOT written to disk. Re-emit the full block."
                ),
                "duration_ms": 0.0,
            }
            self._in_file = False
            self._file_content = ""
            self._buf = ""
            return

        if self._in_edit_block:
            yield {
                "type": "tool_end",
                "id": self._edit_id,
                "name": "edit_file",
                "success": False,
                "output": (
                    f"Error: <edit> block for '{self._edit_path}' was never closed "
                    "with </edit>. Re-emit the full block including </old>, </new>, "
                    "and </edit>."
                ),
                "duration_ms": 0.0,
            }
            self._in_edit_block = False
            self._edit_body = ""
            self._buf = ""
            return

        if self._buf:
            yield {"type": "token", "content": self._buf}
            self._buf = ""

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _drain(self) -> Generator[dict[str, Any], None, None]:
        while self._buf:
            prev_len = len(self._buf)
            if self._in_file:
                yield from self._drain_file()
            elif self._in_edit_block:
                yield from self._drain_edit_block()
            else:
                yield from self._drain_normal()
            # Stop if no progress (buffer at chunk boundary — need more data)
            if len(self._buf) == prev_len:
                break

    def _drain_normal(self) -> Generator[dict[str, Any], None, None]:
        # Find the earliest of <file ...>, <edit ... />, <edit ...>.
        file_m = _OPEN_RE.search(self._buf)
        edit_self_m = _EDIT_SELF_RE.search(self._buf)
        edit_open_m = _EDIT_OPEN_RE.search(self._buf)

        # Pick the earliest start.
        candidates = [m for m in (file_m, edit_self_m, edit_open_m) if m is not None]
        chosen = min(candidates, key=lambda m: m.start()) if candidates else None

        if chosen is file_m and file_m is not None:
            yield from self._handle_file_open(file_m)
            return

        if chosen is edit_self_m and edit_self_m is not None:
            yield from self._handle_edit_self(edit_self_m)
            return

        if chosen is edit_open_m and edit_open_m is not None:
            yield from self._handle_edit_block_open(edit_open_m)
            return

        # No complete tag. Is there a partial "<file " or "<edit " anywhere?
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

        path = m.group(1).strip()
        file_id = f"ftag-{int(time.monotonic() * 1_000_000) % 10_000_000}"

        # Emit the opening tag itself as a token (kept in history; stripped by UI)
        yield {"type": "token", "content": m.group(0) + "\n"}

        # Validate path. Reject empty / relative paths up front so the model
        # gets a clear error instead of mystery disk writes into the backend cwd.
        if not _is_absolute_path(path):
            yield {
                "type": "tool_start",
                "id": file_id,
                "name": "write_file",
                "input": {"path": path},
            }
            yield {
                "type": "tool_end",
                "id": file_id,
                "name": "write_file",
                "success": False,
                "output": (
                    f"Error: <file> path must be absolute, got {path!r}. "
                    "Use a Windows path like C:\\Users\\you\\file.txt or a "
                    "WSL path like /home/you/file.txt."
                ),
                "duration_ms": 0.0,
            }
            # Skip past the opening tag — content (if any) will stream as chat
            # text. Not ideal, but better than silently swallowing it.
            self._buf = self._buf[m.end() :]
            return

        # Switch to file-capture mode
        self._file_path = path
        self._file_id = file_id
        self._file_content = ""
        self._in_file = True
        self._buf = self._buf[m.end() :]

        yield {
            "type": "tool_start",
            "id": self._file_id,
            "name": "write_file",
            "input": {"path": self._file_path},
        }

    def _handle_edit_self(self, m: re.Match[str]) -> Generator[dict[str, Any], None, None]:
        """Self-closing <edit path="..." old="..." new="..." />."""
        before = self._buf[: m.start()]
        if before:
            yield {"type": "token", "content": before}

        attrs = _parse_attrs(m.group(1))
        path = attrs.get("path", "").strip()
        old = attrs.get("old", "")
        new = attrs.get("new", "")

        yield {"type": "token", "content": m.group(0) + "\n"}
        yield from self._emit_edit(path, old, new)
        self._buf = self._buf[m.end():]

    def _handle_edit_block_open(self, m: re.Match[str]) -> Generator[dict[str, Any], None, None]:
        """Opening <edit path="..."> of the block form. Enter edit-block mode."""
        before = self._buf[: m.start()]
        if before:
            yield {"type": "token", "content": before}

        attrs = _parse_attrs(m.group(1))
        self._edit_path = attrs.get("path", "").strip()
        self._edit_id = f"etag-{int(time.monotonic() * 1_000_000) % 10_000_000}"
        self._edit_body = ""
        self._in_edit_block = True

        # Emit opening tag for history (UI strips it)
        yield {"type": "token", "content": m.group(0) + "\n"}
        self._buf = self._buf[m.end():]

    def _drain_edit_block(self) -> Generator[dict[str, Any], None, None]:
        idx = self._buf.find(_EDIT_CLOSE)
        if idx >= 0:
            self._edit_body += self._buf[:idx]
            self._buf = self._buf[idx + len(_EDIT_CLOSE):]
            self._in_edit_block = False

            yield {"type": "token", "content": _EDIT_CLOSE + "\n"}

            old, new, err = self._parse_edit_body(self._edit_body)
            path = self._edit_path
            eid = self._edit_id
            self._edit_body = ""

            if err is not None:
                yield {
                    "type": "tool_start",
                    "id": eid,
                    "name": "edit_file",
                    "input": {"path": path, "old": old, "new": new},
                }
                yield {
                    "type": "tool_end",
                    "id": eid,
                    "name": "edit_file",
                    "success": False,
                    "output": f"Edit failed: {err}",
                    "duration_ms": 0.0,
                }
                return

            yield from self._emit_edit(path, old, new, eid=eid)
        else:
            # Hold back chars that could be the start of </edit>
            safe = _safe_end(self._buf, _EDIT_CLOSE)
            if safe > 0:
                self._edit_body += self._buf[:safe]
                self._buf = self._buf[safe:]
            # else: need more data, stop draining

    def _drain_file(self) -> Generator[dict[str, Any], None, None]:
        idx = self._buf.find(_FILE_CLOSE)
        if idx >= 0:
            # Emit all content before the closing tag
            chunk = self._buf[:idx]
            if chunk:
                self._file_content += chunk
                yield {"type": "tool_chunk", "id": self._file_id, "content": chunk}

            # Emit closing tag as token (stripped by UI, kept in history)
            yield {"type": "token", "content": _FILE_CLOSE + "\n"}

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

            self._buf = self._buf[idx + len(_FILE_CLOSE) :]
            self._in_file = False
        else:
            # Hold back chars that could be the start of </file>
            safe = _safe_end(self._buf, _FILE_CLOSE)
            if safe > 0:
                chunk = self._buf[:safe]
                self._file_content += chunk
                yield {"type": "tool_chunk", "id": self._file_id, "content": chunk}
                self._buf = self._buf[safe:]
            # else: need more data, stop draining

    # ── helpers used by edit paths ────────────────────────────────────

    def _emit_edit(
        self,
        path: str,
        old: str,
        new: str,
        eid: str | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        """Emit tool_start + tool_end for a parsed edit. The loop performs the
        actual on-disk replacement via _edit_file_from_tag."""
        eid = eid or f"etag-{int(time.monotonic() * 1_000_000) % 10_000_000}"
        yield {
            "type": "tool_start",
            "id": eid,
            "name": "edit_file",
            "input": {"path": path, "old": old, "new": new},
        }
        # Mark tool_end with _edit_path so the loop overwrites success/output
        # with the real result after performing the replacement.
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

    @staticmethod
    def _parse_edit_body(body: str) -> tuple[str, str, str | None]:
        """Extract <old> and <new> sections from an <edit>...</edit> body.

        Returns (old, new, error). On error, old/new are empty strings and
        error is a short human-readable reason.
        """
        om = _OLD_RE.search(body)
        nm = _NEW_RE.search(body)
        if om is None:
            return "", "", "missing <old>...</old> inside <edit> block"
        if nm is None:
            return "", "", "missing <new>...</new> inside <edit> block"
        old = _strip_edge_newline(om.group(1))
        new = _strip_edge_newline(nm.group(1))
        if not old:
            return "", "", "<old>...</old> is empty — use <file> to create a file"
        return old, new, None


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
