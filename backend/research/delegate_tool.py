"""run_subagents — the lead delegates a whole round of parallel investigations.

One call runs the entire round, which is what makes the agents actually
concurrent regardless of how the surrounding loop sequences tool calls. It is
also where the budget is spent: the tool, not the prompt, is what stops a run
from spawning agents forever, and it reports the remaining budget back so the
model can plan its next move instead of being cut off mid-thought.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from research.budget import BudgetTracker
from research.progress import ProgressEmitter
from research.types import Finding, SubagentTask
from tools.base import BaseTool, ToolDefinition, ToolSchema

RunRound = Callable[[list[str], list[SubagentTask]], Awaitable[list[Finding]]]


class RunSubagentsTool(BaseTool):
    """Spawns one round of subagents and returns their findings to the lead."""

    name = "run_subagents"
    description = (
        "Run several research subagents in parallel, one per task, and get their "
        "findings back. You write each subagent's prompt yourself — it is the only "
        "instruction that agent receives. Give each one a distinct question; never "
        "send two after the same thing. Call this again for a later round if real "
        "gaps remain."
    )

    def __init__(
        self,
        *,
        tracker: BudgetTracker,
        emitter: ProgressEmitter,
        run_round: RunRound,
    ) -> None:
        self._tracker = tracker
        self._emitter = emitter
        self._run_round = run_round
        self._spawned = 0
        #: Every finding from every round — the lead's evidence base, and the
        #: source list the citation audit checks the report against.
        self.findings: list[Finding] = []

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "description": (
                                f"The tasks for this round, at most "
                                f"{self._tracker.budget.max_parallel} of them."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {
                                        "type": "string",
                                        "description": (
                                            "Short readable label shown to the user "
                                            "while this subagent works."
                                        ),
                                    },
                                    "prompt": {
                                        "type": "string",
                                        "description": (
                                            "The subagent's complete instruction: what "
                                            "to find, which sources to trust, what to "
                                            "bring back, how much effort to spend. "
                                            "Write it in the report's language. This "
                                            "is all the subagent will ever see — it "
                                            "has no access to the brief or your plan."
                                        ),
                                    },
                                },
                                "required": ["title", "prompt"],
                            },
                        }
                    },
                    "required": ["tasks"],
                },
            )
        )

    async def execute(self, tasks: Any = None, **_: Any) -> str:
        parsed = _parse_tasks(tasks)
        if not parsed:
            return (
                "Error: run_subagents needs a 'tasks' array of "
                "{title, prompt} objects, each with a non-empty prompt."
            )

        refusal = self._tracker.refusal()
        if refusal is not None:
            return (
                f"No subagents were started. {refusal} "
                "Work with the findings you already have and call submit_report."
            )

        granted = self._tracker.open_round(len(parsed))
        if granted <= 0:
            return (
                f"No subagents were started. {self._tracker.status_line()} "
                "Call submit_report with what you have."
            )

        trimmed = parsed[:granted]
        agent_ids = [f"a{self._spawned + i}" for i in range(1, len(trimmed) + 1)]
        self._spawned += len(trimmed)

        findings = await self._run_round(agent_ids, trimmed)
        self.findings.extend(findings)

        header = f"Subagent results — {len(findings)} task(s)."
        if len(trimmed) < len(parsed):
            header += (
                f" Note: you asked for {len(parsed)} but only {len(trimmed)} slots "
                "were left, so the extra tasks were dropped."
            )
        body = "\n\n".join(_format_finding(f) for f in findings)
        return f"{header}\n\n{body}\n\n{self._tracker.status_line()}"


def _parse_tasks(tasks: Any) -> list[SubagentTask]:
    """Accept the documented shape, and a bare list of prompt strings."""
    if isinstance(tasks, dict):
        tasks = [tasks]
    if not isinstance(tasks, list):
        return []
    out: list[SubagentTask] = []
    for index, item in enumerate(tasks, 1):
        if isinstance(item, str):
            prompt = item.strip()
            title = prompt[:80]
        elif isinstance(item, dict):
            prompt = str(item.get("prompt") or item.get("task") or "").strip()
            title = str(item.get("title") or "").strip() or prompt[:80]
        else:
            continue
        if prompt:
            out.append(SubagentTask(title=title or f"Task {index}", prompt=prompt))
    return out


def _format_finding(finding: Finding) -> str:
    """One subagent's result, as the lead reads it."""
    lines = [f"### [{finding.agent_id}] {finding.title}", f"status: {finding.status}"]
    if finding.error:
        lines.append(f"error: {finding.error}")
    if finding.summary:
        lines.append("")
        lines.append(finding.summary)
    if finding.gaps:
        lines.append("")
        lines.append(f"Gaps: {finding.gaps}")
    if finding.sources:
        lines.append("")
        lines.append("Sources:")
        lines.extend(f"- {url}" for url in finding.sources)
    return "\n".join(lines)
