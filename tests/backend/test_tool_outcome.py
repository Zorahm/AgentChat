"""A tool that returns its own error text has failed, and must say so.

Tools here never raise — they catch and return ``Error: …`` so the turn can keep
going. That made "no exception" indistinguishable from "worked": a failed
write_file reached the UI with a green check next to a file that was never
created. These pin the classifier that closes the gap, and the fact that it only
moves the flag — the model's view and the loop's flow are untouched.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.config import AgentConfig  # noqa: E402
from agent.loop import AgentLoop  # noqa: E402
from agent.tool_outcome import looks_failed  # noqa: E402
from tools.base import BaseTool, ToolDefinition, ToolSchema  # noqa: E402
from tools.registry import ToolRegistry  # noqa: E402


class TestErrorTextIsAFailure:
    @pytest.mark.parametrize(
        "output",
        [
            "Error: file not found — /tmp/a.txt",
            "Error writing file: [Errno 13] Permission denied",
            "Error: Sandbox: writes are only allowed inside the chat folder",
            "Error: invalid arguments for 'write_file' — unexpected keyword",
        ],
    )
    def test_both_error_shapes_the_tools_actually_return(self, output: str) -> None:
        assert looks_failed("write_file", output)

    @pytest.mark.parametrize(
        "output",
        ["Created /tmp/a.txt (12 bytes)", "Wrote 3 files", "", "(no output)"],
    )
    def test_ordinary_results_stay_successful(self, output: str) -> None:
        assert not looks_failed("write_file", output)


class TestBashJudgedByItsMarkers:
    def test_a_non_zero_exit_is_a_failure(self) -> None:
        assert looks_failed("bash_tool", "bash: nope: command not found\n[exit code: 127]")

    def test_a_spawn_failure_is_a_failure(self) -> None:
        assert looks_failed("bash_tool", "[bash_tool error] command timed out after 300s.")

    def test_a_command_that_merely_prints_the_word_error_is_not(self) -> None:
        """bash relays someone else's stdout — 'Error' in it is data, not a
        verdict. The exit code is the verdict, and here it was zero."""
        assert not looks_failed("bash_tool", "Error: connection refused\nretrying...\nok")

    def test_a_successful_command_is_not_a_failure(self) -> None:
        assert not looks_failed("bash_tool", "total 4\ndrwxr-xr-x 2 u u 4096 Aug 11 10:00 .")


class TestContentToolsKeepTheBenefitOfTheDoubt:
    def test_its_own_one_line_error_is_a_failure(self) -> None:
        assert looks_failed("read_file", "Error: file not found — /tmp/a.txt")

    def test_a_log_file_starting_with_the_word_error_is_not(self) -> None:
        """read_file returns whatever is in the file. A log opening with
        'Error: …' must not paint the read itself red."""
        log = "Error: connection refused\nError: retry 1\nError: retry 2\nrecovered\n"
        assert not looks_failed("read_file", log)

    def test_a_long_single_line_is_treated_as_content(self) -> None:
        assert not looks_failed("read_file", "Error: " + "x" * 400)


class _FailingTool(BaseTool):
    """Mirrors every real tool here: catches its own failure, returns it as text."""

    name = "write_file"
    description = "test"

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(function=ToolSchema(name=self.name, description=self.description))

    async def execute(self, **_: Any) -> str:
        return "Error: Sandbox: writes are only allowed inside the chat folder"


def _toolcall_chunk(call_id: str, name: str, arguments: str) -> SimpleNamespace:
    tc = SimpleNamespace(index=0, id=call_id, function=SimpleNamespace(name=name, arguments=arguments))
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class _ToolThenTextLLM:
    def __init__(self, args: str, final: str) -> None:
        delta = SimpleNamespace(content=final, tool_calls=None)
        self._turns = [
            [_toolcall_chunk("call-1", "write_file", args)],
            [SimpleNamespace(choices=[SimpleNamespace(delta=delta)])],
        ]
        self.call_count = 0

    async def completion_stream(self, **_: Any) -> Any:
        turn = self._turns[self.call_count]
        self.call_count += 1
        for chunk in turn:
            yield chunk


class TestTheLoopReportsIt:
    @pytest.mark.asyncio
    async def test_a_failed_write_ends_as_a_failure_without_stopping_the_turn(self) -> None:
        registry = ToolRegistry()
        registry.register(_FailingTool())
        llm = _ToolThenTextLLM('{"path": "/etc/passwd", "content": "x"}', "I could not write that.")
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=registry,
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("write it")]

        end = next(e for e in events if e["type"] == "tool_end")
        assert end["success"] is False
        assert "Sandbox" in end["output"]  # the user can read what happened

        # The turn carried on: the model was called again and answered.
        assert llm.call_count == 2
        assert events[-1] == {"type": "done"}
        # And it saw the error text verbatim, as the tool result.
        tool_msg = next(m for m in loop.messages if m.get("role") == "tool")
        assert tool_msg["content"] == "Error: Sandbox: writes are only allowed inside the chat folder"
