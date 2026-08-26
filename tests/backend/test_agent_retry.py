"""The retry policy behind the loop's graceful degradation.

Two properties matter more than the schedule itself:

* a fatal failure must NOT be retried — ten waits of up to thirty seconds on a
  rejected API key is five minutes of silence where the user needed one line of
  text, and no number of attempts will make the key valid;
* a retried pass must not re-run tools. The loop's history carries the results
  of everything that already ran, and re-executing a `write_file` because the
  provider dropped the socket afterwards is data loss, not resilience.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.config import AgentConfig
from agent.loop import AgentLoop
from retry import (
    LLM_POLICY,
    TOOL_POLICY,
    RetryPolicy,
    backoff_delay,
    is_retryable,
    looks_like_lost_connection,
    retry_after_seconds,
)
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.registry import ToolRegistry


class _StatusError(Exception):
    """Stand-in for a provider error carrying an HTTP status, as litellm's do."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class _NamedError(Exception):
    """Base for errors we classify by class name, the way litellm names them."""


class APIConnectionError(_NamedError):
    pass


class ServiceUnavailableError(_NamedError):
    pass


class AuthenticationError(_NamedError):
    pass


class ContextWindowExceededError(_NamedError):
    pass


class TestIsRetryable:
    @pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504, 529])
    def test_transient_statuses_retry(self, status: int) -> None:
        assert is_retryable(_StatusError("upstream sad", status)) is True

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 413, 422])
    def test_client_errors_are_fatal(self, status: int) -> None:
        assert is_retryable(_StatusError("nope", status)) is False

    def test_context_window_is_fatal_even_at_500(self) -> None:
        """Some gateways answer an over-long prompt with a 500. Sending the same
        oversized prompt ten more times cannot make it fit."""
        assert is_retryable(_StatusError("context length exceeded", 500)) is False

    def test_network_errors_retry_without_a_status(self) -> None:
        assert is_retryable(ConnectionResetError("connection reset by peer")) is True
        assert is_retryable(TimeoutError("read timed out")) is True
        assert is_retryable(APIConnectionError("connection error")) is True
        assert is_retryable(ServiceUnavailableError("overloaded")) is True

    def test_auth_and_context_names_are_fatal(self) -> None:
        assert is_retryable(AuthenticationError("bad key")) is False
        assert is_retryable(ContextWindowExceededError("too long")) is False

    def test_unknown_exception_is_fatal(self) -> None:
        """A bug in our own code must surface, not be swallowed ten times."""
        assert is_retryable(ValueError("bad json")) is False
        assert is_retryable(KeyError("choices")) is False

    def test_cancellation_is_never_retried(self) -> None:
        assert is_retryable(asyncio.CancelledError()) is False


class TestBackoff:
    def test_delay_grows_and_is_capped(self) -> None:
        policy = RetryPolicy(attempts=10, base=1.0, cap=30.0)
        delays = [backoff_delay(policy, attempt, jitter=False) for attempt in range(1, 11)]
        assert delays[:6] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0]
        assert all(d == 30.0 for d in delays[5:])

    def test_each_attempt_waits_at_least_as_long(self) -> None:
        policy = RetryPolicy(attempts=10, base=1.0, cap=30.0)
        delays = [backoff_delay(policy, attempt, jitter=False) for attempt in range(1, 11)]
        assert all(b >= a for a, b in zip(delays, delays[1:]))

    def test_jitter_stays_inside_the_window(self) -> None:
        policy = RetryPolicy(attempts=10, base=1.0, cap=30.0)
        for attempt in range(1, 11):
            ceiling = backoff_delay(policy, attempt, jitter=False)
            for _ in range(20):
                delay = backoff_delay(policy, attempt)
                assert 0.0 <= delay <= ceiling

    def test_llm_budget_is_ten_attempts_tools_get_fewer(self) -> None:
        """A tool freezing the loop for three minutes is worse than a failed
        search the model can route around, so its budget is deliberately smaller."""
        assert LLM_POLICY.attempts == 10
        assert TOOL_POLICY.attempts < LLM_POLICY.attempts


class TestWhatToTellTheUser:
    """`is_retryable` decides whether to try again; this decides what to say.

    They disagree on the case that matters: litellm gives a refused connection
    a status of 500, so classifying by the number alone tells a user whose LM
    Studio is simply not running that their provider is having an outage."""

    def test_a_refused_connection_reads_as_a_lost_connection(self) -> None:
        refused = APIConnectionError("connection error")
        refused.status_code = 500  # type: ignore[attr-defined]
        assert looks_like_lost_connection(refused) is True

    def test_a_real_server_error_does_not(self) -> None:
        assert looks_like_lost_connection(_StatusError("internal error", 500)) is False

    def test_builtin_socket_failures_count(self) -> None:
        assert looks_like_lost_connection(ConnectionResetError("reset")) is True
        assert looks_like_lost_connection(TimeoutError("timed out")) is True


class TestRetryAfter:
    def test_reads_numeric_header(self) -> None:
        exc = _StatusError("slow down", 429)
        exc.response_headers = {"retry-after": "12"}  # type: ignore[attr-defined]
        assert retry_after_seconds(exc) == 12.0

    def test_ignores_absent_or_junk_header(self) -> None:
        assert retry_after_seconds(_StatusError("slow down", 429)) is None
        exc = _StatusError("slow down", 429)
        exc.response_headers = {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}  # type: ignore[attr-defined]
        assert retry_after_seconds(exc) is None

    def test_clamped_to_the_policy_cap(self) -> None:
        """A provider asking for an hour must not park the whole turn for one."""
        exc = _StatusError("slow down", 429)
        exc.response_headers = {"retry-after": "3600"}  # type: ignore[attr-defined]
        assert retry_after_seconds(exc, cap=30.0) == 30.0


# ── The loop's side of it ────────────────────────────────────────────────────


def _chunk(content: str) -> SimpleNamespace:
    delta = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _toolcall_chunk(call_id: str, name: str, arguments: str) -> SimpleNamespace:
    tc = SimpleNamespace(
        index=0, id=call_id, function=SimpleNamespace(name=name, arguments=arguments)
    )
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class _CountingTool(BaseTool):
    """Records every execution, so a test can prove a retry did not re-run it."""

    name = "count"
    description = "counts its own calls"

    def __init__(self) -> None:
        self.runs = 0

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(function=ToolSchema(name=self.name, description=self.description))

    async def execute(self, **_: Any) -> str:
        self.runs += 1
        return f"run {self.runs}"


class _ScriptedLLM:
    """Replays a script of turns; a turn may end by raising instead of finishing.

    Each entry is a list of chunks, optionally ending with an exception instance
    that is raised at that point in the stream — which is exactly what a dropped
    connection looks like from the loop's side.
    """

    def __init__(self, turns: list[list[Any]]) -> None:
        self._turns = turns
        self.call_count = 0

    async def completion_stream(
        self, *, model: str, messages: Any, tools: Any = None,
        extra_body: Any = None, metadata: Any = None,
    ) -> Any:
        turn = self._turns[min(self.call_count, len(self._turns) - 1)]
        self.call_count += 1
        for item in turn:
            if isinstance(item, BaseException):
                raise item
            yield item


@pytest.fixture
def no_waiting(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[float]]:
    """Run the backoff at full speed, recording what it would have waited."""
    waited: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(seconds: float) -> None:
        waited.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    yield waited


def _dropped() -> Exception:
    return ConnectionResetError("connection reset by peer")


class TestLoopFreezesAndRetries:
    @pytest.mark.asyncio
    async def test_partial_pass_is_rewound_then_produced_again(
        self, no_waiting: list[float]
    ) -> None:
        llm = _ScriptedLLM(
            turns=[
                [_chunk("Half an ans"), _dropped()],
                [_chunk("The whole answer.")],
            ]
        )
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("hi")]
        kinds = [e["type"] for e in events]

        assert "stream_retry" in kinds
        # The rewind has to come before the replacement text, or the client
        # would wipe the good answer instead of the abandoned one.
        assert kinds.index("pass_rewind") < len(kinds) - 1
        retry = next(e for e in events if e["type"] == "stream_retry")
        assert retry["attempt"] == 1
        assert retry["max_attempts"] == 10
        assert retry["kind"] == "network"

        # History keeps the finished answer only — not the truncated one.
        assert loop.messages[-1]["content"] == "The whole answer."

    @pytest.mark.asyncio
    async def test_a_retry_does_not_re_run_finished_tools(
        self, no_waiting: list[float]
    ) -> None:
        """The pass is retried; the tool that already ran is not.

        This is the property that makes freezing safe: a provider that drops the
        socket after a write_file must not cause a second write."""
        tool = _CountingTool()
        registry = ToolRegistry()
        registry.register(tool)
        llm = _ScriptedLLM(
            turns=[
                [_toolcall_chunk("c1", "count", "{}")],   # pass 1: call the tool
                [_chunk("summary so f"), _dropped()],     # pass 2: dies mid-answer
                [_chunk("done")],                          # pass 2, retried
            ]
        )
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=registry,
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("hi")]

        assert tool.runs == 1
        assert sum(1 for e in events if e["type"] == "stream_retry") == 1
        assert loop.messages[-1]["content"] == "done"

    @pytest.mark.asyncio
    async def test_fatal_error_is_not_retried(self, no_waiting: list[float]) -> None:
        bad_key = _StatusError("invalid api key", 401)
        llm = _ScriptedLLM(turns=[[_chunk("x"), bad_key]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        with pytest.raises(_StatusError):
            async for _ in loop.run_stream("hi"):
                pass

        assert llm.call_count == 1
        assert no_waiting == []

    @pytest.mark.asyncio
    async def test_gives_up_after_the_budget_and_reports_the_failure(
        self, no_waiting: list[float]
    ) -> None:
        llm = _ScriptedLLM(turns=[[_dropped()]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events: list[dict[str, Any]] = []
        with pytest.raises(ConnectionResetError):
            async for ev in loop.run_stream("hi"):
                events.append(ev)

        retries = [e for e in events if e["type"] == "stream_retry"]
        assert llm.call_count == LLM_POLICY.attempts
        assert [r["attempt"] for r in retries] == list(range(1, LLM_POLICY.attempts))

    @pytest.mark.asyncio
    async def test_long_waits_keep_the_response_alive(
        self, no_waiting: list[float], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A half-minute of silence is a stream a proxy may cut, so the wait
        is broken into steps that each put a byte on the wire."""
        monkeypatch.setattr("agent.loop.next_delay", lambda *_a, **_k: 20.0)
        llm = _ScriptedLLM(turns=[[_dropped()], [_chunk("ok")]])
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=ToolRegistry(),
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("hi")]

        assert sum(1 for e in events if e["type"] == "ping") == 3  # 20s / 5s - 1
        assert no_waiting == [5.0, 5.0, 5.0, 5.0]
