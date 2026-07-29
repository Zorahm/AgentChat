"""Fan-out tests — one subagent must never be able to take the round down with it."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from research import fanout
from research.progress import ProgressEmitter
from research.types import Finding, SubagentTask


def _tasks(n: int) -> list[SubagentTask]:
    return [SubagentTask(title=f"task {i}", prompt=f"do {i}") for i in range(1, n + 1)]


def _ids(n: int) -> list[str]:
    return [f"a{i}" for i in range(1, n + 1)]


def _drain(queue: "asyncio.Queue[dict[str, Any]]") -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


class TestRunRound:
    @pytest.mark.asyncio
    async def test_one_failure_and_one_hang_do_not_stop_the_others(self) -> None:
        async def run_one(agent_id: str, task: SubagentTask) -> Finding:
            if agent_id == "a2":
                raise RuntimeError("provider exploded")
            if agent_id == "a3":
                await asyncio.sleep(30)
            return Finding(agent_id=agent_id, title=task.title, summary="found it")

        findings = await fanout.run_round(
            tasks=_tasks(3),
            agent_ids=_ids(3),
            run_one=run_one,
            timeout_s=0.05,
            emitter=ProgressEmitter(),
        )

        assert [f.status for f in findings] == ["ok", "failed", "timeout"]
        assert "provider exploded" in findings[1].error
        assert findings[0].summary == "found it"

    @pytest.mark.asyncio
    async def test_every_started_agent_reports_an_end(self) -> None:
        queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

        async def run_one(agent_id: str, task: SubagentTask) -> Finding:
            if agent_id == "a2":
                raise RuntimeError("nope")
            return Finding(agent_id=agent_id, title=task.title, sources=["http://a.com"])

        await fanout.run_round(
            tasks=_tasks(2),
            agent_ids=_ids(2),
            run_one=run_one,
            timeout_s=1.0,
            emitter=ProgressEmitter(queue),
        )

        events = _drain(queue)
        assert sorted(e["agentId"] for e in events if e["kind"] == "agent_start") == ["a1", "a2"]
        ends = {e["agentId"]: e for e in events if e["kind"] == "agent_end"}
        assert set(ends) == {"a1", "a2"}
        assert ends["a1"]["status"] == "ok"
        assert ends["a1"]["sources"] == 1
        assert ends["a2"]["status"] == "failed"

    @pytest.mark.asyncio
    async def test_they_actually_run_concurrently(self) -> None:
        """Three 100ms agents must finish in well under 300ms."""
        async def run_one(agent_id: str, task: SubagentTask) -> Finding:
            await asyncio.sleep(0.1)
            return Finding(agent_id=agent_id, title=task.title)

        started = asyncio.get_running_loop().time()
        await fanout.run_round(
            tasks=_tasks(3),
            agent_ids=_ids(3),
            run_one=run_one,
            timeout_s=5.0,
            emitter=ProgressEmitter(),
        )
        assert asyncio.get_running_loop().time() - started < 0.25

    @pytest.mark.asyncio
    async def test_cancelling_the_round_cancels_the_agents(self) -> None:
        """A closed SSE stream must not leave subagent loops burning tokens."""
        queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()
        entered = asyncio.Event()
        cancelled: list[str] = []

        async def run_one(agent_id: str, task: SubagentTask) -> Finding:
            entered.set()
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                cancelled.append(agent_id)
                raise
            return Finding(agent_id=agent_id, title=task.title)

        round_task = asyncio.create_task(
            fanout.run_round(
                tasks=_tasks(2),
                agent_ids=_ids(2),
                run_one=run_one,
                timeout_s=30.0,
                emitter=ProgressEmitter(queue),
            )
        )
        await entered.wait()
        round_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await round_task

        assert sorted(cancelled) == ["a1", "a2"]
        ends = [e for e in _drain(queue) if e["kind"] == "agent_end"]
        assert {e["status"] for e in ends} == {"cancelled"}

    @pytest.mark.asyncio
    async def test_empty_round_is_a_no_op(self) -> None:
        assert await fanout.run_round(
            tasks=[], agent_ids=[], run_one=_unreachable, timeout_s=1.0, emitter=ProgressEmitter()
        ) == []


async def _unreachable(agent_id: str, task: SubagentTask) -> Finding:
    raise AssertionError("no subagent should run for an empty round")
