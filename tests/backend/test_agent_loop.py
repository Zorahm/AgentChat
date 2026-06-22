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
from agent.loop import AgentLoop
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

    async def completion_stream(self, *, model: str, messages: Any, tools: Any = None, extra_body: Any = None) -> Any:
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
