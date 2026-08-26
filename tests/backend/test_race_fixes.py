"""Regression tests for the ordering / race fixes found in review.

Each test pins one defect that was reachable from the UI:

* an empty POST /chats body overwriting a tree the debounced PUT had saved;
* DELETE /chats purging a folder while that chat's agent was still streaming;
* an unrelated 4xx being read as "this model has no vision" and silently
  dropping the user's image;
* the tool-call argument scanner re-decoding the whole buffer per chunk.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.loop import _is_unrelated_4xx, _is_vision_rejection  # noqa: E402
from agent.partial_json import ArgScanner  # noqa: E402
from agent.tool_stream import emit_tool_call_progress  # noqa: E402
from api.active_streams import ActiveStreams  # noqa: E402
from store.chat_store import ChatStore  # noqa: E402


# ── POST /chats must not clobber a saved tree ──────────────────────────────


def test_upsert_with_empty_root_keeps_stored_tree(tmp_path: Path) -> None:
    store = ChatStore(tmp_path / "chats.db")
    store.upsert_chat(chat_id="c1", title="t", dir_slug="chat-a-1", root=[])
    tree = [{"id": "n1", "role": "user", "variants": [], "activeVariantIdx": 0}]
    store.update_chat(chat_id="c1", root=tree)

    # The late POST: same id, empty root. Used to wipe the message the user sent.
    store.upsert_chat(chat_id="c1", title="t", dir_slug="chat-a-1", root=[])

    chat = store.get_chat("c1")
    assert chat is not None
    assert chat["root"] == tree
    store.close()


def test_upsert_with_a_real_root_still_replaces(tmp_path: Path) -> None:
    store = ChatStore(tmp_path / "chats.db")
    store.upsert_chat(chat_id="c1", title="t", dir_slug="d", root=[{"id": "old"}])
    store.upsert_chat(chat_id="c1", title="t", dir_slug="d", root=[{"id": "new"}])

    chat = store.get_chat("c1")
    assert chat is not None
    assert chat["root"] == [{"id": "new"}]
    store.close()


# ── DELETE waits for a live stream ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_wait_idle_blocks_until_the_stream_ends() -> None:
    streams = ActiveStreams()
    streams.begin("c1")

    waiter = asyncio.ensure_future(streams.wait_idle("c1", timeout=5.0))
    await asyncio.sleep(0)
    assert not waiter.done()

    streams.end("c1")
    assert await waiter is True


@pytest.mark.asyncio
async def test_wait_idle_times_out_while_still_streaming() -> None:
    streams = ActiveStreams()
    streams.begin("c1")
    assert await streams.wait_idle("c1", timeout=0.01) is False


@pytest.mark.asyncio
async def test_wait_idle_returns_at_once_when_nothing_runs() -> None:
    streams = ActiveStreams()
    assert await streams.wait_idle("c1", timeout=0.01) is True
    assert await streams.wait_idle("", timeout=0.01) is True


@pytest.mark.asyncio
async def test_concurrent_streams_on_one_chat_all_have_to_finish() -> None:
    streams = ActiveStreams()
    streams.begin("c1")
    streams.begin("c1")

    waiter = asyncio.ensure_future(streams.wait_idle("c1", timeout=5.0))
    streams.end("c1")
    await asyncio.sleep(0)
    assert not waiter.done()  # one stream still running

    streams.end("c1")
    assert await waiter is True
    assert not streams.is_active("c1")


# ── vision fallback must not eat unrelated 4xx ─────────────────────────────


def test_context_length_error_is_not_a_vision_rejection() -> None:
    msg = "This model's maximum context length is 8192 tokens"
    assert _is_unrelated_4xx(msg)
    assert not _is_vision_rejection(msg)


def test_real_vision_rejections_still_match() -> None:
    for msg in (
        "This model does not support image input",
        "unknown variant `image_url`, expected `text`",
    ):
        assert _is_vision_rejection(msg)
        assert not _is_unrelated_4xx(msg)


def test_rate_limit_and_auth_errors_are_unrelated() -> None:
    assert _is_unrelated_4xx("Rate limit reached for gpt-4o")
    assert _is_unrelated_4xx("Incorrect API key provided")


# ── incremental argument scanner ───────────────────────────────────────────


def _scan_in_chunks(full_args: str, key: str, step: int) -> str:
    """Feed *full_args* to the scanner one slice at a time, as streaming does."""
    scanner = ArgScanner()
    out = ""
    for end in range(step, len(full_args) + step, step):
        out += "".join(chunk for k, chunk in scanner.feed(full_args[:end]).text if k == key)
    return out


def test_scanner_is_chunk_size_independent() -> None:
    args = '{"path":"/tmp/a.txt","content":"line one\\nline two\\ttabbed"}'
    expected = "line one\nline two\ttabbed"
    for step in (1, 3, 7, 50, 999):
        assert _scan_in_chunks(args, "content", step) == expected


def test_scanner_handles_a_unicode_escape_split_across_chunks() -> None:
    # Ж lands mid-escape at several of these boundaries — the old code's
    # `i + 5 <= len` bound decoded a 3-digit prefix and emitted the wrong char.
    args = '{"content":"a\\u0416b"}'
    for step in range(1, len(args) + 1):
        assert _scan_in_chunks(args, "content", step) == "aЖb"


def test_scanner_pairs_surrogates_split_across_chunks() -> None:
    """Emitting the halves separately yields a lone surrogate, which cannot be
    encoded as UTF-8 and blows up when the SSE event is serialised."""
    args = '{"content":"hi \\ud83d\\ude00"}'
    for step in range(1, len(args) + 1):
        assert _scan_in_chunks(args, "content", step) == "hi 😀"


def test_scanner_stops_at_the_closing_quote() -> None:
    args = '{"content":"done","path":"/x"}'
    assert _scan_in_chunks(args, "content", 4) == "done"


def test_scanner_returns_nothing_until_the_key_appears() -> None:
    scanner = ArgScanner()
    assert scanner.feed('{"pa').text == []
    assert scanner.feed('{"path":"/x","content":"hi').text == [("path", "/x"), ("content", "hi")]


def test_scanner_decodes_each_character_exactly_once() -> None:
    """The O(n²) defect: every chunk re-decoded the whole accumulated buffer, so
    a large write_file was re-scanned once per token."""
    body = "x" * 500
    args = f'{{"content":"{body}"}}'
    assert _scan_in_chunks(args, "content", 7) == body


def test_tool_input_deltas_assemble_into_the_whole_value() -> None:
    """The UI appends each delta to what it already has, so the deltas must be
    disjoint, in order, and continue exactly where tool_start left off."""
    state: dict[int, dict[str, object]] = {}
    progress: dict[str, dict[str, object]] = {}
    events = []
    for chunk in ('{"comm', 'and":"ls ', '-la /tmp"}'):
        entry = state.setdefault(
            0, {"id": "c1", "type": "function", "function": {"name": "bash_tool", "arguments": ""}}
        )
        fn = entry["function"]
        assert isinstance(fn, dict)
        fn["arguments"] = str(fn["arguments"]) + chunk
        events.extend(emit_tool_call_progress(state, progress))

    start = next(e for e in events if e["type"] == "tool_start")
    command = str(start["input"].get("command", ""))
    for event in events:
        if event["type"] == "tool_input_delta" and event["key"] == "command":
            command += str(event["chunk"])
    assert command == "ls -la /tmp"
