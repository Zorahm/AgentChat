"""Runs a round of subagents concurrently, isolating their failures.

Parallelism lives here rather than in the lead's tool loop on purpose: the lead
delegates a whole round in a single ``run_subagents`` call, so the agents start
together no matter how the surrounding loop chooses to execute tool calls.

Three guarantees the caller depends on:
  * one subagent crashing or hanging never cancels its siblings;
  * every started agent produces exactly one ``agent_end`` event, whatever happened;
  * cancelling the run cancels the subagents and propagates, so a closed SSE
    stream doesn't leave loops burning tokens in the background.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from research.progress import AgentStatus, ProgressEmitter
from research.types import Finding, SubagentTask

RunOne = Callable[[str, SubagentTask], Awaitable[Finding]]

#: Trimmed to keep the panel readable — the full text goes to the lead, not the UI.
_SUMMARY_PREVIEW = 220


async def run_round(
    *,
    tasks: list[SubagentTask],
    agent_ids: list[str],
    run_one: RunOne,
    timeout_s: float,
    emitter: ProgressEmitter,
) -> list[Finding]:
    """Run every task concurrently and return one Finding per task, in order."""
    if not tasks:
        return []

    async def guarded(agent_id: str, task: SubagentTask) -> Finding:
        emitter.agent_start(agent_id, task.title)
        try:
            finding = await asyncio.wait_for(run_one(agent_id, task), timeout_s)
        except asyncio.CancelledError:
            emitter.agent_end(agent_id, "cancelled")
            raise
        except asyncio.TimeoutError:
            finding = Finding(
                agent_id=agent_id,
                title=task.title,
                status="timeout",
                error=f"gave up after {int(timeout_s)}s",
            )
        except Exception as exc:  # noqa: BLE001 — a dead subagent is data, not a crash
            finding = Finding(
                agent_id=agent_id,
                title=task.title,
                status="failed",
                error=str(exc),
            )
        emitter.agent_end(
            agent_id,
            _status_of(finding),
            sources=len(finding.sources),
            summary=finding.summary[:_SUMMARY_PREVIEW],
        )
        return finding

    results = await asyncio.gather(
        *(guarded(aid, task) for aid, task in zip(agent_ids, tasks)),
        return_exceptions=True,
    )

    findings: list[Finding] = []
    for agent_id, task, result in zip(agent_ids, tasks, results):
        if isinstance(result, Finding):
            findings.append(result)
            continue
        # gather() only hands back an exception when `guarded` itself broke —
        # its own handlers already cover anything the subagent raised.
        findings.append(
            Finding(
                agent_id=agent_id,
                title=task.title,
                status="failed",
                error=str(result),
            )
        )
    return findings


def _status_of(finding: Finding) -> AgentStatus:
    """Narrow the Finding's free-form status onto the progress vocabulary."""
    if finding.status == "ok":
        return "ok"
    if finding.status == "timeout":
        return "timeout"
    if finding.status == "cancelled":
        return "cancelled"
    return "failed"
