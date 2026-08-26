"""Incremental decoding of a tool call's JSON arguments while they stream in.

LLMs emit tool-call arguments as one JSON string built token by token. Waiting
for the closing brace before showing anything makes a long call read as "hung",
so the UI is fed the arguments *as* the model types them.

:class:`ArgScanner` walks the accumulated argument string exactly once: the
cursor only moves forward and the parse state (which key, inside a string,
nesting depth) survives between calls. That is what keeps streaming linear — the
earlier regex-per-chunk version re-decoded the whole buffer on every delta, so a
200 KB ``write_file`` cost O(n²).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

# Parser states.
_EXPECT_KEY = "expect_key"
_IN_KEY = "in_key"
_EXPECT_COLON = "expect_colon"
_EXPECT_VALUE = "expect_value"
_IN_STRING = "in_string"
_IN_NESTED = "in_nested"
_IN_SCALAR = "in_scalar"
_DONE = "done"

_WHITESPACE = " \t\n\r"
_SCALAR_END = ",}] \t\n\r"

_SIMPLE_ESCAPES: dict[str, str] = {
    "n": "\n", "t": "\t", "r": "\r", '"': '"',
    "\\": "\\", "/": "/", "b": "\b", "f": "\f",
}


@dataclass
class ArgProgress:
    """What a single :meth:`ArgScanner.feed` decoded.

    Strings report *growth* rather than their new full value: re-sending a
    growing value on every chunk is O(n²) on the wire, which a 50 KB
    ``show_widget`` payload turns into megabytes of SSE.
    """

    #: ``(key, newly decoded characters)`` for string arguments, in arrival order.
    text: list[tuple[str, str]] = field(default_factory=list)
    #: ``(key, value)`` for numbers/bools/null/objects/arrays, once fully parsed.
    done: list[tuple[str, Any]] = field(default_factory=list)


class ArgScanner:
    """Streaming decoder for one tool call's top-level JSON argument object.

    Feed it the *accumulated* argument string after every delta chunk; it
    returns only what that chunk added. ``values`` holds the best-effort
    arguments so far (strings may still be mid-word), ``completed`` names the
    keys whose value is finished.
    """

    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.completed: set[str] = set()
        self._pos = 0
        self._state = _EXPECT_KEY
        self._key = ""
        self._key_buf: list[str] = []
        # Raw-slice bookkeeping for nested containers and bare scalars.
        self._raw_start = 0
        self._depth = 0
        self._raw_in_string = False
        self._raw_escape = False

    def completed_value(self, key: str) -> Any | None:
        """The value of *key* once fully decoded, else ``None``."""
        return self.values.get(key) if key in self.completed else None

    def feed(self, args_str: str) -> ArgProgress:
        """Decode whatever *args_str* has grown by since the last call."""
        progress = ArgProgress()
        n = len(args_str)
        while self._pos < n and self._state != _DONE:
            c = args_str[self._pos]

            if self._state == _EXPECT_KEY:
                if c == '"':
                    self._key_buf = []
                    self._pos += 1
                    self._state = _IN_KEY
                elif c == "}":
                    self._pos += 1
                    self._state = _DONE
                else:
                    # Whitespace, the opening brace, commas — and any junk a
                    # provider slips in. Skipping keeps the scanner unstalled.
                    self._pos += 1

            elif self._state == _IN_KEY:
                self._pos, closed = _scan_string(args_str, self._pos, self._key_buf)
                if not closed:
                    break
                self._key = "".join(self._key_buf)
                self._key_buf = []
                self._state = _EXPECT_COLON

            elif self._state == _EXPECT_COLON:
                self._pos += 1
                if c == ":":
                    self._state = _EXPECT_VALUE

            elif self._state == _EXPECT_VALUE:
                if c in _WHITESPACE:
                    self._pos += 1
                elif c == '"':
                    self.values.setdefault(self._key, "")
                    self._pos += 1
                    self._state = _IN_STRING
                elif c in "{[":
                    self._raw_start = self._pos
                    self._depth = 0
                    self._raw_in_string = False
                    self._raw_escape = False
                    self._state = _IN_NESTED
                else:
                    self._raw_start = self._pos
                    self._state = _IN_SCALAR

            elif self._state == _IN_STRING:
                buf: list[str] = []
                self._pos, closed = _scan_string(args_str, self._pos, buf)
                if buf:
                    chunk = "".join(buf)
                    prior = self.values.get(self._key)
                    self.values[self._key] = (prior if isinstance(prior, str) else "") + chunk
                    progress.text.append((self._key, chunk))
                if not closed:
                    break
                self.completed.add(self._key)
                self._state = _EXPECT_KEY

            elif self._state == _IN_NESTED:
                if not self._scan_nested(args_str):
                    break
                self._commit(args_str[self._raw_start : self._pos], progress)

            else:  # _IN_SCALAR
                i = self._pos
                while i < n and args_str[i] not in _SCALAR_END:
                    i += 1
                self._pos = i
                if i >= n:
                    break  # the token may still be growing — don't commit half a number
                self._commit(args_str[self._raw_start : i], progress)

        return progress

    # ── internals ──────────────────────────────────────────────────────

    def _scan_nested(self, args_str: str) -> bool:
        """Advance past a nested object/array. True once it closed.

        Depth, in-string and escape flags persist across calls, so a container
        split over many chunks is still scanned character-exactly-once.
        """
        i = self._pos
        n = len(args_str)
        while i < n:
            ch = args_str[i]
            if self._raw_escape:
                self._raw_escape = False
            elif self._raw_in_string:
                if ch == "\\":
                    self._raw_escape = True
                elif ch == '"':
                    self._raw_in_string = False
            elif ch == '"':
                self._raw_in_string = True
            elif ch in "{[":
                self._depth += 1
            elif ch in "}]":
                self._depth -= 1
                if self._depth == 0:
                    self._pos = i + 1
                    return True
            i += 1
        self._pos = i
        return False

    def _commit(self, raw: str, progress: ArgProgress) -> None:
        """Record a finished non-string value and report it."""
        text = raw.strip()
        try:
            value: Any = json.loads(text)
        except ValueError:
            value = text
        self.values[self._key] = value
        self.completed.add(self._key)
        progress.done.append((self._key, value))
        self._state = _EXPECT_KEY


def _scan_string(s: str, i: int, buf: list[str]) -> tuple[int, bool]:
    """Decode JSON string body characters from *i* into *buf*.

    Returns ``(index, closed)``. Stops without consuming anything when an escape
    straddles a chunk boundary, so the next feed picks it up whole.
    """
    while i < len(s):
        c = s[i]
        if c == '"':
            return i + 1, True
        if c != "\\":
            buf.append(c)
            i += 1
            continue
        if i + 1 >= len(s):
            return i, False  # escape split across chunks
        nc = s[i + 1]
        if nc != "u":
            buf.append(_SIMPLE_ESCAPES.get(nc, nc))
            i += 2
            continue
        if i + 6 > len(s):
            return i, False  # \uXXXX split across chunks
        try:
            code = int(s[i + 2 : i + 6], 16)
        except ValueError:
            buf.append(nc)  # malformed escape — emit it literally rather than stall
            i += 2
            continue
        i += 6
        if 0xD800 <= code <= 0xDBFF:
            # A surrogate pair spans two \u escapes. Emitting the halves
            # separately yields a lone surrogate, which cannot be encoded as
            # UTF-8 and would blow up when the event is serialised.
            if i + 6 > len(s) and (i >= len(s) or s[i] == "\\"):
                return i - 6, False  # the low half may still be coming
            low = -1
            if i + 6 <= len(s) and s[i] == "\\" and s[i + 1] == "u":
                try:
                    low = int(s[i + 2 : i + 6], 16)
                except ValueError:
                    low = -1
            if 0xDC00 <= low <= 0xDFFF:
                buf.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                i += 6
            else:
                buf.append("�")
            continue
        buf.append(chr(code))
    return i, False
