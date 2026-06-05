"""Tests for the agent loop."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.config import AgentConfig
from agent.loop import AgentLoop
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
