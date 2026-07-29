"""research tool — hands a model-written brief to a multi-agent research run.

Registered per-request only when the chat's research toggle is on. Internally it
drives a :class:`~research.lead.LeadResearcher`: a lead agent that plans, delegates
to parallel subagents, and writes a cited report saved into the chat folder. The
path comes back so the MAIN agent can surface it via ``present_files``.

Progress streams live — ``agent.loop`` drains ``progress_queue`` and forwards each
event as ``tool_progress`` while ``execute`` runs (hence ``streams_progress``).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from agent.sandbox import SandboxPolicy
from research.lead import LeadResearcher
from research.types import ModelEndpoint, ResearchOutcome
from tools.base import BaseTool, ToolDefinition, ToolSchema
from web_search.service import WebSearchService

if TYPE_CHECKING:
    from store.settings_store import SettingsStore

_BRIEF_GUIDE = (
    "The research brief, written by you. This is the ONLY thing the research "
    "team receives — it never sees this conversation — so it has to stand alone. "
    "Write it as markdown covering: the goal in one sentence; the concrete "
    "sub-questions worth answering; anything already established that shouldn't "
    "be re-derived; constraints that narrow the scope (time period, region, "
    "audience, which sources count as credible); how deep to go and roughly how "
    "long the report should be; what the report must contain and how it should be "
    "structured; and the language to write it in — ALWAYS the user's language. "
    "Be specific: a vague brief produces a vague report."
)


class ResearchTool(BaseTool):
    """Run a multi-agent research investigation and save a cited report."""

    name = "research"
    description = (
        "Run deep, multi-step web research and save a cited markdown report. A lead "
        "researcher plans the work, delegates it to several subagents that search and "
        "read in parallel, then synthesizes their findings. Use it for questions that "
        "need thorough, source-backed investigation across many sources (current "
        "events, comparisons, market or literature scans) — not for a single lookup, "
        "which web_search answers faster. You write the brief that drives the whole "
        "run, so put everything the team needs into it. When it returns, call "
        "present_files with the EXACT absolute path it gives you, then summarize the "
        "findings in 2-3 sentences."
    )
    # Signals agent.loop to run execute() as a task and forward progress_queue
    # events as tool_progress while it runs.
    streams_progress = True

    def __init__(
        self,
        *,
        store: SettingsStore,
        web_search_service: WebSearchService,
        lead: ModelEndpoint,
        worker: ModelEndpoint,
        usage_metadata: dict[str, Any] | None = None,
    ) -> None:
        self._store = store
        self._service = web_search_service
        self._lead = lead
        self._worker = worker
        self._usage_metadata = usage_metadata
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)
        # Structured progress events (plan / agent_* / note / done) that
        # agent.loop forwards to the UI as tool_progress.
        self.progress_queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {"brief": {"type": "string", "description": _BRIEF_GUIDE}},
                    "required": ["brief"],
                },
            )
        )

    async def execute(
        self,
        brief: str | None = None,
        topic: str | None = None,
        **_: object,
    ) -> str:
        # `topic` is not advertised; it is accepted because models that learned
        # the old single-topic shape otherwise lose the whole call.
        text = (brief or topic or "").strip()
        if not text:
            return "Error: research needs a 'brief' describing what to investigate."

        researcher = LeadResearcher(
            store=self._store,
            service=self._service,
            lead=self._lead,
            worker=self._worker,
            policy=self._policy,
            progress_queue=self.progress_queue,
            usage_metadata=self._usage_metadata,
            temperature=self._store.temperature,
        )
        outcome: ResearchOutcome = await researcher.run(text)

        if not outcome.ok:
            return _failure_message(outcome)

        lines = [
            f"Research complete — report saved to {outcome.path}",
            "",
            "Next: call present_files with this EXACT absolute path — "
            f"present_files(paths=['{outcome.path}']) — to show the report, then give "
            "a 2-3 sentence summary of the findings.",
        ]
        if outcome.warnings:
            lines += ["", "Warnings to mention to the user:", *(f"- {w}" for w in outcome.warnings)]
        lines += ["", f"Report abstract:\n{_abstract(outcome.report)}"]
        return "\n".join(lines)


def _failure_message(outcome: ResearchOutcome) -> str:
    """Failure text that still carries the report when only saving it failed."""
    if outcome.report:
        return f"{outcome.message}\n\nThe full report:\n\n{outcome.report}"
    return outcome.message


def _abstract(report: str, limit: int = 600) -> str:
    """A short lead excerpt of the report for the tool result."""
    text = report.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + " …"
