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


class TestFileTagAbort:
    """A failed <file>/<edit> mid-stream must cut the model off and re-prompt."""

    @pytest.mark.asyncio
    async def test_failed_file_tag_aborts_stream_and_reprompts(self) -> None:
        llm = _FakeLLM(
            turns=[
                # Turn 1: prose, then a relative-path <file> (rejected by the
                # interceptor → failure with no _path marker), then prose that
                # must never be consumed because we abort on the failure.
                [
                    "I'll write the file. ",
                    '<file path="relative.txt">',
                    "AFTER_ABORT_MARKER must never be consumed",
                ],
                # Turn 2 (re-prompt after the error): clean terminal reply.
                ["Sorry, using an absolute path next time."],
            ]
        )
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("write a file")]

        # Re-prompted exactly once after the abort.
        assert llm.call_count == 2
        # The chunk after the failed tag was never pulled from the stream.
        assert "AFTER_ABORT_MARKER must never be consumed" not in llm.yielded_pieces
        # A failed tool_end reached the UI, and the run still terminated cleanly.
        assert any(e.get("type") == "tool_end" and e.get("success") is False for e in events)
        assert events[-1] == {"type": "done"}

        # The error was fed back to the model, prefixed with the interruption note.
        feedback = [
            m
            for m in loop.messages
            if m["role"] == "user"
            and isinstance(m["content"], str)
            and m["content"].startswith("Your message was stopped early")
        ]
        assert len(feedback) == 1
        assert "must be absolute" in feedback[0]["content"]

        # The prose after the failed tag never leaked into conversation history.
        assert all("AFTER_ABORT_MARKER" not in str(m.get("content", "")) for m in loop.messages)
