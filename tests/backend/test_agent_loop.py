"""Tests for the agent loop."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import asyncio

from agent.config import AgentConfig
from agent.loop import (
    AgentLoop,
    _is_bad_request,
    _is_vision_rejection,
    _strip_image_blocks,
)
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.registry import ToolRegistry


def _chunk(content: str | None = None) -> SimpleNamespace:
    """Build a minimal LiteLLM-shaped streaming chunk carrying text content."""
    delta = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class _FakeLLM:
    """Stand-in for LLMClient. Replays one content turn per stream call.

    Tracks how many chunks were actually pulled so a test can prove the loop
    stopped consuming the stream early.
    """

    def __init__(self, turns: list[list[str]]) -> None:
        self._turns = turns
        self.call_count = 0
        self.yielded_pieces: list[str] = []

    async def completion_stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Any:
        turn = self._turns[self.call_count]
        self.call_count += 1
        for piece in turn:
            self.yielded_pieces.append(piece)
            yield _chunk(content=piece)


class TestPlainTextStreaming:
    """With <file>/<edit> removed, assistant text streams straight through as
    tokens — no tag parsing, no interception, no abort."""

    @pytest.mark.asyncio
    async def test_text_turn_streams_tokens_and_finishes(self) -> None:
        llm = _FakeLLM(turns=[["Hello ", "world."]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("hi")]

        tokens = [e["content"] for e in events if e.get("type") == "token"]
        assert "".join(tokens) == "Hello world."
        assert events[-1] == {"type": "done"}
        # The full reply is recorded in history verbatim.
        assert loop.messages[-1] == {"role": "assistant", "content": "Hello world."}

    @pytest.mark.asyncio
    async def test_file_like_text_is_not_intercepted(self) -> None:
        # A literal "<file …>" in prose must pass through untouched now: no
        # tool_start/tool_end, no abort, no stripping at the loop layer.
        raw = 'Here is <file path="/x">raw</file> shown literally.'
        llm = _FakeLLM(turns=[[raw]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("x")]

        assert not any(e.get("type") in ("tool_start", "tool_end") for e in events)
        text = "".join(e["content"] for e in events if e.get("type") == "token")
        assert text == raw
        assert events[-1] == {"type": "done"}


class TestThinkTagReasoning:
    """Providers that stream <think>…</think> inside delta.content (MiniMax M2/M3
    and friends) must surface that as reasoning events, not as answer tokens."""

    @pytest.mark.asyncio
    async def test_think_block_becomes_reasoning_not_tokens(self) -> None:
        llm = _FakeLLM(turns=[["<think>plan ", "more</think>", "the answer"]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("draw")]

        reasoning = "".join(e["content"] for e in events if e.get("type") == "reasoning")
        tokens = "".join(e["content"] for e in events if e.get("type") == "token")
        assert reasoning == "plan more"
        assert tokens == "the answer"
        # Thinking is stored in history under reasoning_content; the answer body
        # is clean (no tags, no thought text).
        assert loop.messages[-1] == {
            "role": "assistant",
            "content": "the answer",
            "reasoning_content": "plan more",
        }

    @pytest.mark.asyncio
    async def test_think_tag_split_across_chunks(self) -> None:
        llm = _FakeLLM(turns=[["<thi", "nk>x</think>y"]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("hi")]

        reasoning = "".join(e["content"] for e in events if e.get("type") == "reasoning")
        tokens = "".join(e["content"] for e in events if e.get("type") == "token")
        assert reasoning == "x"
        assert tokens == "y"


def _toolcall_chunk(call_id: str, name: str, arguments: str) -> SimpleNamespace:
    tc = SimpleNamespace(index=0, id=call_id, function=SimpleNamespace(name=name, arguments=arguments))
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class _ToolThenTextLLM:
    """Turn 0 emits a tool call; turn 1 emits final text."""

    def __init__(self, call_id: str, name: str, args: str, final: str) -> None:
        self._turns = [[_toolcall_chunk(call_id, name, args)], [_chunk(content=final)]]
        self.call_count = 0

    async def completion_stream(
        self, *, model: str, messages: Any, tools: Any = None, extra_body: Any = None, metadata: Any = None
    ) -> Any:
        turn = self._turns[self.call_count]
        self.call_count += 1
        for ch in turn:
            yield ch


class _StreamingTool(BaseTool):
    """A tool that publishes progress lines while running (like research)."""

    name = "slow"
    description = "test streaming tool"
    streams_progress = True

    def __init__(self) -> None:
        self.progress_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(function=ToolSchema(name=self.name, description=self.description))

    async def execute(self, **_: Any) -> str:
        self.progress_queue.put_nowait({"kind": "step", "n": 1})
        self.progress_queue.put_nowait({"kind": "step", "n": 2})
        await asyncio.sleep(0)  # yield so the loop can drain mid-flight
        return "tool finished"


class TestAskUserPausesTurn:
    """ask_user is non-blocking: the tool returns at once and the loop ends the
    turn (emitting user_question + done) instead of calling the model again.
    The user's answers arrive later as a brand-new user message."""

    @pytest.mark.asyncio
    async def test_ask_user_emits_question_and_ends_turn(self) -> None:
        from tools.ask_user import AskUserTool

        registry = ToolRegistry()
        registry.register(AskUserTool())
        args = '{"questions": [{"question": "Pick", "options": ["a", "b"]}], "selection_type": "single"}'
        llm = _ToolThenTextLLM("call-1", "ask_user", args, "should never run")
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=registry,
            llm=llm,  # type: ignore[arg-type]
            chat_id="chat-1",
        )

        events = [ev async for ev in loop.run_stream("go")]

        # The model was called exactly once — the loop did NOT resume after asking.
        assert llm.call_count == 1
        uq = next(e for e in events if e.get("type") == "user_question")
        assert uq["id"] == "call-1"
        assert uq["chat_id"] == "chat-1"
        assert uq["selection_type"] == "single"
        assert uq["questions"][0]["question"] == "Pick"
        # Tool ran and the turn ended cleanly.
        end = next(e for e in events if e.get("type") == "tool_end" and e.get("id") == "call-1")
        assert end["success"] is True
        assert events[-1] == {"type": "done"}


class TestStreamingToolProgress:
    """A tool flagged streams_progress has its queued events forwarded as
    tool_progress events for its call id, then runs to completion normally."""

    @pytest.mark.asyncio
    async def test_progress_events_forwarded_as_tool_progress(self) -> None:
        registry = ToolRegistry()
        registry.register(_StreamingTool())
        llm = _ToolThenTextLLM("call-1", "slow", "{}", "done")
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=registry,
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("go")]

        progress = [e["event"] for e in events if e.get("type") == "tool_progress" and e.get("id") == "call-1"]
        assert progress == [{"kind": "step", "n": 1}, {"kind": "step", "n": 2}]
        end = next(e for e in events if e.get("type") == "tool_end" and e.get("id") == "call-1")
        assert end["success"] is True
        assert end["output"] == "tool finished"
        assert events[-1] == {"type": "done"}


class TestVisionRejectionDetection:
    """A model without vision rejects image input in many shapes; the loop must
    recognise them so it can strip the pixels and keep going in text."""

    def test_prose_no_vision_message(self) -> None:
        assert _is_vision_rejection(
            "This model does not support image input."
        )

    def test_deepseek_schema_deserialize_error(self) -> None:
        # The exact shape DeepSeek returns: not a prose "no vision" message but a
        # JSON-schema deserialize failure naming the image_url variant.
        msg = (
            "litellm.BadRequestError: OpenAIException - Error from provider "
            "(DeepSeek): Failed to deserialize the JSON body into the target "
            "type: messages[1]: unknown variant `image_url`, expected `text` "
            "at line 1 column 200111"
        )
        assert _is_vision_rejection(msg)

    def test_unrelated_image_error_is_not_a_rejection(self) -> None:
        # Mentions "image" but is a genuine I/O failure — must NOT trip the
        # fallback (subject without a negation marker).
        assert not _is_vision_rejection("Failed to download image from URL.")

    def test_strip_replaces_user_image_with_note(self) -> None:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": "sys"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this?"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            },
        ]
        found = _strip_image_blocks(messages, "no vision")
        assert found is True
        blocks = messages[1]["content"]
        assert not any(b.get("type") == "image_url" for b in blocks)
        assert any(b["type"] == "text" and "no vision" in b["text"] for b in blocks)


class TestBadRequestBackstop:
    """Providers behind an Anthropic-compatible (or other) gateway reject a
    non-vision model's image with wording we can't enumerate, but always a 4xx.
    The structural backstop catches those regardless of the error text."""

    def test_4xx_status_code_is_bad_request(self) -> None:
        exc = RuntimeError("messages.0.content.1.image: not understood")
        exc.status_code = 400  # type: ignore[attr-defined]
        assert _is_bad_request(exc)

    def test_422_is_bad_request(self) -> None:
        exc = RuntimeError("unprocessable")
        exc.status_code = 422  # type: ignore[attr-defined]
        assert _is_bad_request(exc)

    def test_class_name_fallback_without_status_code(self) -> None:
        class BadRequestError(Exception):
            pass

        assert _is_bad_request(BadRequestError("anything"))

    def test_5xx_is_not_bad_request(self) -> None:
        exc = RuntimeError("upstream exploded")
        exc.status_code = 503  # type: ignore[attr-defined]
        assert not _is_bad_request(exc)

    def test_plain_exception_is_not_bad_request(self) -> None:
        # A network/stream error with no status code must NOT trigger the strip.
        assert not _is_bad_request(RuntimeError("connection reset"))


class _RaiseThenTextLLM:
    """Raises a provider error on the first stream, then streams text. Records
    the messages it saw on the second call so a test can prove images were
    stripped before the retry."""

    def __init__(self, exc: Exception, text: str) -> None:
        self._exc = exc
        self._text = text
        self.call_count = 0
        self.second_call_messages: list[dict[str, Any]] | None = None

    async def completion_stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Any:
        self.call_count += 1
        if self.call_count == 1:
            raise self._exc
            yield  # unreachable — makes this function an async generator
        self.second_call_messages = messages
        yield _chunk(content=self._text)


class TestVisionRetryIntegration:
    """End-to-end: a 4xx while the request carries an image must strip the pixels
    and transparently retry the pass in text — even with unguessable error text."""

    @pytest.mark.asyncio
    async def test_4xx_strips_image_and_retries_in_text(self) -> None:
        exc = RuntimeError("provider rejected the request")  # no vision wording
        exc.status_code = 400  # type: ignore[attr-defined]
        reply = "I can't see the image, but I can work with the file."
        llm = _RaiseThenTextLLM(exc, reply)
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )
        user_input: list[dict[str, Any]] = [
            {"type": "text", "text": "what is this?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ]

        events = [ev async for ev in loop.run_stream(user_input)]

        # Retried once: the loop swallowed the 4xx, stripped, and finished in text.
        assert llm.call_count == 2
        tokens = "".join(e["content"] for e in events if e.get("type") == "token")
        assert tokens == reply
        assert events[-1] == {"type": "done"}
        # The retry request carried no image blocks.
        assert llm.second_call_messages is not None
        for m in llm.second_call_messages:
            content = m.get("content")
            if isinstance(content, list):
                assert not any(b.get("type") == "image_url" for b in content)
