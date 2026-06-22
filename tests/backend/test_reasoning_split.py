"""Tests for ThinkTagSplitter — separating <think>…</think> out of a token stream.

Some providers (MiniMax M2/M3 and other open reasoning models served over a
plain OpenAI/Anthropic-compatible endpoint) emit their chain-of-thought wrapped
in literal ``<think>…</think>`` tags inside ``delta.content`` instead of the
dedicated ``reasoning_content`` field. The splitter normalises that stream into
``("reasoning", …)`` / ``("content", …)`` segments so the loop can route each
to the right SSE event. It must survive tags that straddle chunk boundaries.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.reasoning_split import ThinkTagSplitter


def _drive(pieces: list[str]) -> tuple[str, str, list[tuple[str, str]]]:
    """Feed every piece, then flush. Return (reasoning, content, raw_segments)."""
    splitter = ThinkTagSplitter()
    segments: list[tuple[str, str]] = []
    for p in pieces:
        segments.extend(splitter.feed(p))
    segments.extend(splitter.flush())
    reasoning = "".join(t for k, t in segments if k == "reasoning")
    content = "".join(t for k, t in segments if k == "content")
    return reasoning, content, segments


class TestPlainContent:
    def test_no_tags_passes_through_as_content(self) -> None:
        reasoning, content, _ = _drive(["Hello ", "world."])
        assert reasoning == ""
        assert content == "Hello world."

    def test_stray_lt_is_not_held_forever(self) -> None:
        # A '<' that never becomes <think> must still be emitted (here it's
        # part of "<div>", unrelated markup the model wrote in prose).
        reasoning, content, _ = _drive(["a <", "div> b"])
        assert reasoning == ""
        assert content == "a <div> b"

    def test_other_tag_not_mistaken_for_think(self) -> None:
        raw = 'Here is <file path="/x">raw</file> shown.'
        reasoning, content, _ = _drive([raw])
        assert reasoning == ""
        assert content == raw


class TestSingleChunkTags:
    def test_think_block_then_answer(self) -> None:
        reasoning, content, _ = _drive(["<think>planning</think>answer"])
        assert reasoning == "planning"
        assert content == "answer"

    def test_content_before_and_after_think(self) -> None:
        reasoning, content, _ = _drive(["pre<think>mid</think>post"])
        assert reasoning == "mid"
        assert content == "prepost"

    def test_think_with_no_trailing_answer(self) -> None:
        reasoning, content, _ = _drive(["<think>just thinking</think>"])
        assert reasoning == "just thinking"
        assert content == ""


class TestSplitAcrossChunks:
    def test_open_tag_split(self) -> None:
        reasoning, content, _ = _drive(["<thi", "nk>idea</think>done"])
        assert reasoning == "idea"
        assert content == "done"

    def test_close_tag_split(self) -> None:
        reasoning, content, _ = _drive(["<think>idea</thi", "nk>done"])
        assert reasoning == "idea"
        assert content == "done"

    def test_reasoning_spans_many_feeds(self) -> None:
        reasoning, content, _ = _drive(
            ["<think>", "step 1 ", "step 2 ", "step 3", "</think>", "final"]
        )
        assert reasoning == "step 1 step 2 step 3"
        assert content == "final"

    def test_tag_one_char_at_a_time(self) -> None:
        reasoning, content, _ = _drive(list("<think>hi</think>yo"))
        assert reasoning == "hi"
        assert content == "yo"


class TestFlush:
    def test_unterminated_think_flushes_as_reasoning(self) -> None:
        # Stream ended mid-thought (no closing tag). The buffered remainder
        # belongs to the mode we were in — reasoning.
        reasoning, content, _ = _drive(["<think>cut off mid-thou"])
        assert reasoning == "cut off mid-thou"
        assert content == ""

    def test_dangling_partial_open_flushes_as_content(self) -> None:
        # A trailing '<' held back for partial-tag detection must not be eaten
        # when the stream ends.
        reasoning, content, _ = _drive(["answer<"])
        assert reasoning == ""
        assert content == "answer<"
