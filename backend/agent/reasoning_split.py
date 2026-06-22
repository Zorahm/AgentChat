"""Split ``<think>…</think>`` chain-of-thought out of a streamed token stream.

Most reasoning models expose their thoughts in a dedicated ``reasoning_content``
delta field, which ``AgentLoop`` already forwards as ``reasoning`` events. But
some providers — MiniMax M2/M3, and other open reasoning models served behind a
plain OpenAI/Anthropic-compatible endpoint — instead emit the thoughts as literal
``<think>…</think>`` tags inside ``delta.content``. Left alone, that thinking
streams to the UI as the answer body (the tags render invisibly in markdown).

``ThinkTagSplitter`` consumes the ``content`` stream chunk by chunk and yields
``("reasoning", text)`` / ``("content", text)`` segments so the loop can route
each to the right SSE event. The state machine is streaming-safe: a tag split
across two chunks (``"<thi"`` + ``"nk>"``) is detected by holding back any
trailing run that could be the start of the tag we're currently looking for.

Scope: only explicit, exact ``<think>`` / ``</think>`` pairs are recognised.
Variants that omit the opening tag (reasoning streamed before a lone closing
tag) are intentionally not handled — splitting those mid-stream would risk
misclassifying ordinary models' output.
"""

from __future__ import annotations

from collections.abc import Iterable

_OPEN = "<think>"
_CLOSE = "</think>"

# Segment kinds.
REASONING = "reasoning"
CONTENT = "content"

Segment = tuple[str, str]


def _partial_suffix_len(buf: str, target: str) -> int:
    """Length of the longest *proper* suffix of ``buf`` that prefixes ``target``.

    This is the run at the end of the buffer that might still grow into ``target``
    once more text arrives, so it must be held back rather than emitted. A full
    occurrence is found separately via ``str.find`` and never reaches here.
    """
    max_k = min(len(buf), len(target) - 1)
    for k in range(max_k, 0, -1):
        if buf[-k:] == target[:k]:
            return k
    return 0


class ThinkTagSplitter:
    """Stateful, streaming-safe splitter for ``<think>…</think>`` content."""

    def __init__(self) -> None:
        self._inside = False
        self._buf = ""

    def feed(self, text: str) -> list[Segment]:
        """Consume one ``content`` chunk; return any complete segments.

        Text that might be the leading edge of a tag straddling the next chunk
        is buffered internally and surfaced on a later ``feed`` or ``flush``.
        """
        if not text:
            return []
        self._buf += text
        out: list[Segment] = []
        while True:
            target = _CLOSE if self._inside else _OPEN
            idx = self._buf.find(target)
            if idx != -1:
                before = self._buf[:idx]
                if before:
                    out.append((REASONING if self._inside else CONTENT, before))
                self._buf = self._buf[idx + len(target) :]
                self._inside = not self._inside
                continue
            # No full tag in the buffer. Emit everything except a trailing run
            # that could still complete into the tag on the next chunk.
            hold = _partial_suffix_len(self._buf, target)
            emit_upto = len(self._buf) - hold
            if emit_upto > 0:
                out.append((REASONING if self._inside else CONTENT, self._buf[:emit_upto]))
                self._buf = self._buf[emit_upto:]
            break
        return out

    def flush(self) -> list[Segment]:
        """Emit any buffered remainder at end of stream, in the current mode."""
        if not self._buf:
            return []
        seg: Segment = (REASONING if self._inside else CONTENT, self._buf)
        self._buf = ""
        return [seg]


def iter_segments(splitter: ThinkTagSplitter, chunks: Iterable[str]) -> list[Segment]:
    """Convenience: feed every chunk then flush, returning all segments."""
    out: list[Segment] = []
    for c in chunks:
        out.extend(splitter.feed(c))
    out.extend(splitter.flush())
    return out
