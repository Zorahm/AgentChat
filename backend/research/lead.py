"""LeadResearcher — drives one research run from brief to written report.

The lead is a nested ``AgentLoop`` whose tools let it publish a plan, delegate
rounds of parallel subagents, search and read on its own, and submit a report.
It never raises into its caller: every failure comes back as a
:class:`~research.types.ResearchOutcome` with ``ok=False``. Cancellation is the
one exception — a closed SSE stream must be allowed to tear the run down.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from agent.config import AgentConfig
from agent.loop import AgentLoop
from agent.sandbox import SandboxPolicy
from llm.client import LLMClient
from research import fanout
from research.budget import BudgetTracker, ResearchBudget
from research.delegate_tool import RunSubagentsTool
from research.lead_tools import NoteTool, PlanResearchTool, SubmitReportTool
from research.observer import LoopObserver
from research.progress import LEAD_AGENT_ID, ProgressEmitter
from research.prompts import build_lead_prompt, build_salvage_message
from research.report import resolve_report_path, write_report
from research.sources import audit_citations, dedupe
from research.toolset import (
    NO_BACKEND_MESSAGE,
    WebAccess,
    build_research_registry,
    native_tools,
    resolve_web_access,
)
from research.types import Finding, ModelEndpoint, ResearchOutcome, SubagentTask
from research.worker import SubagentRunner
from tools.registry import ToolRegistry
from web_search.service import WebSearchService

if TYPE_CHECKING:
    from store.settings_store import SettingsStore

#: Iterations granted to the salvage pass — enough to call submit_report, not
#: enough to start investigating again.
_SALVAGE_ITERATIONS = 3


class LeadResearcher:
    """One research run. Construct fresh per ``research`` tool call."""

    def __init__(
        self,
        *,
        store: SettingsStore,
        service: WebSearchService,
        lead: ModelEndpoint,
        worker: ModelEndpoint,
        policy: SandboxPolicy,
        budget: ResearchBudget | None = None,
        progress_queue: "asyncio.Queue[dict[str, Any]] | None" = None,
        usage_metadata: dict[str, Any] | None = None,
        temperature: float = 0.7,
    ) -> None:
        self._store = store
        self._service = service
        self._lead = lead
        self._worker = worker
        self._policy = policy
        self._budget = budget or ResearchBudget()
        self._emitter = ProgressEmitter(progress_queue)
        self._usage_metadata = usage_metadata
        self._temperature = temperature

    async def run(self, brief: str) -> ResearchOutcome:
        """Investigate *brief* and write the report. Never raises but for cancellation."""
        access = resolve_web_access(self._store, self._service, self._lead.provider_id, self._lead.model)
        if access is None:
            return ResearchOutcome(ok=False, message=NO_BACKEND_MESSAGE)

        tracker = BudgetTracker(self._budget)
        subagents = SubagentRunner(
            endpoint=self._worker,
            access=access,
            service=self._service,
            policy=self._policy,
            budget=self._budget,
            emitter=self._emitter,
            temperature=self._temperature,
            usage_metadata=self._context_metadata("research_worker", self._worker),
        )

        async def run_round(agent_ids: list[str], tasks: list[SubagentTask]) -> list[Finding]:
            return await fanout.run_round(
                tasks=tasks,
                agent_ids=agent_ids,
                run_one=subagents.run,
                timeout_s=self._budget.worker_timeout_s,
                emitter=self._emitter,
            )

        plan_tool = PlanResearchTool(self._emitter)
        delegate = RunSubagentsTool(tracker=tracker, emitter=self._emitter, run_round=run_round)
        submit = SubmitReportTool()

        registry = build_research_registry(access, self._service, self._policy)
        registry.register(plan_tool)
        registry.register(NoteTool(self._emitter))
        registry.register(delegate)
        registry.register(submit)

        loop = self._build_loop(access, registry)
        observer = LoopObserver(self._emitter, LEAD_AGENT_ID)
        self._emitter.agent_start(LEAD_AGENT_ID, "")

        try:
            await self._drive(loop, observer, submit, brief)
            if not submit.submitted:
                # Out of iterations with no report — one last pass whose only
                # affordable move is to write up what the run already has.
                loop.config.max_iterations = _SALVAGE_ITERATIONS
                await self._drive(loop, observer, submit, build_salvage_message())
        except asyncio.CancelledError:
            self._emitter.agent_end(LEAD_AGENT_ID, "cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 — never raise into the tool
            self._emitter.agent_end(LEAD_AGENT_ID, "failed")
            return ResearchOutcome(ok=False, message=f"Research failed: {exc}")

        known_urls = dedupe(
            [*observer.sources, *(url for f in delegate.findings for url in f.sources)]
        )
        self._emitter.agent_end(
            LEAD_AGENT_ID,
            "ok" if submit.submitted else "failed",
            sources=len(known_urls),
        )

        if not submit.submitted:
            return ResearchOutcome(ok=False, message=_no_report_message(delegate.findings))

        title = submit.title or _title_from(submit.markdown) or brief.strip()[:120]
        path = await resolve_report_path(title, self._policy)
        written = await write_report(path, submit.markdown, self._policy)
        warnings = audit_citations(submit.markdown, known_urls)
        for warning in warnings:
            self._emitter.note(warning)

        if written.startswith("Error"):
            # The work still exists — hand the report back inline rather than lose it.
            return ResearchOutcome(
                ok=False,
                title=title,
                report=submit.markdown,
                message=f"Research finished but saving the report failed ({written}).",
                warnings=warnings,
            )

        self._emitter.done(title, path)
        return ResearchOutcome(
            ok=True, title=title, report=submit.markdown, path=path, warnings=warnings
        )

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _build_loop(self, access: WebAccess, registry: ToolRegistry) -> AgentLoop:
        return AgentLoop(
            config=AgentConfig(
                model=self._lead.lite_model,
                system_prompt=build_lead_prompt(self._budget),
                api_key=self._lead.api_key,
                api_base=self._lead.api_base,
                temperature=self._temperature,
                max_iterations=self._budget.lead_iterations,
                extra_headers=self._lead.extra_headers,
            ),
            tools=registry,
            llm=LLMClient(
                api_base=self._lead.api_base,
                api_key=self._lead.api_key,
                extra_headers=self._lead.extra_headers,
            ),
            policy=self._policy,
            extra_tools=native_tools(access),
            usage_metadata=self._context_metadata("research", self._lead),
        )

    async def _drive(
        self,
        loop: AgentLoop,
        observer: LoopObserver,
        submit: SubmitReportTool,
        message: str,
    ) -> None:
        """Run one pass of the lead loop, stopping the moment the report lands."""
        stream = loop.run_stream(message)
        try:
            async for event in stream:
                observer.feed(event)
                if event.get("type") == "tool_end" and event.get("name") == submit.name:
                    break
        finally:
            await stream.aclose()

    def _context_metadata(self, context: str, endpoint: ModelEndpoint) -> dict[str, Any] | None:
        """Usage-log metadata tagging calls with their role and the model that ran them."""
        if self._usage_metadata is None:
            return None
        return {
            **self._usage_metadata,
            "context": context,
            "provider": endpoint.provider_id or "unknown",
            "canonical_model": endpoint.model,
        }


def _title_from(report: str) -> str:
    """The report's first H1, if it has one."""
    for line in report.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()[:120]
    return ""


def _no_report_message(findings: list[Finding]) -> str:
    """Failure text that still carries whatever the subagents managed to bring back."""
    base = "Research ran but the lead never submitted a report."
    usable = [f for f in findings if f.summary]
    if not usable:
        return base
    collected = "\n\n".join(f"### {f.title}\n{f.summary}" for f in usable)
    return f"{base} Raw findings from the subagents:\n\n{collected}"
