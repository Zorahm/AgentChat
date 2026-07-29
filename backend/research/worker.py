"""SubagentRunner — runs one delegated task in its own agent loop, returns a Finding.

Each subagent is a plain nested ``AgentLoop`` with its own registry, its own LLM
client and its own slice of the timeline. Its system prompt is a fixed role
contract; the *task* — the actual instruction — is written by the lead, which is
what makes a run adapt to the brief instead of to a template.

Nothing raises out of :meth:`SubagentRunner.run` except cancellation: one dead
subagent must not take the run down with it.
"""

from __future__ import annotations

from typing import Any

from agent.config import AgentConfig
from agent.loop import AgentLoop
from agent.sandbox import SandboxPolicy
from llm.client import LLMClient
from research.budget import ResearchBudget
from research.observer import LoopObserver
from research.progress import ProgressEmitter
from research.prompts import build_worker_prompt
from research.sources import dedupe
from research.toolset import WebAccess, build_research_registry, native_tools
from research.types import Finding, ModelEndpoint, SubagentTask
from research.worker_tools import SubmitFindingsTool
from web_search.service import WebSearchService


class SubagentRunner:
    """Runs subagent tasks against one endpoint. Safe to reuse across tasks."""

    def __init__(
        self,
        *,
        endpoint: ModelEndpoint,
        access: WebAccess,
        service: WebSearchService,
        policy: SandboxPolicy,
        budget: ResearchBudget,
        emitter: ProgressEmitter,
        temperature: float = 0.7,
        usage_metadata: dict[str, Any] | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._access = access
        self._service = service
        self._policy = policy
        self._budget = budget
        self._emitter = emitter
        self._temperature = temperature
        self._usage_metadata = usage_metadata

    async def run(self, agent_id: str, task: SubagentTask) -> Finding:
        """Investigate *task* and return what was found."""
        registry = build_research_registry(self._access, self._service, self._policy)
        submit = SubmitFindingsTool()
        registry.register(submit)

        loop = AgentLoop(
            config=AgentConfig(
                model=self._endpoint.lite_model,
                system_prompt=build_worker_prompt(),
                api_key=self._endpoint.api_key,
                api_base=self._endpoint.api_base,
                temperature=self._temperature,
                max_iterations=self._budget.worker_iterations,
                extra_headers=self._endpoint.extra_headers,
            ),
            tools=registry,
            llm=LLMClient(
                api_base=self._endpoint.api_base,
                api_key=self._endpoint.api_key,
                extra_headers=self._endpoint.extra_headers,
            ),
            policy=self._policy,
            extra_tools=native_tools(self._access),
            usage_metadata=self._usage_metadata,
        )

        observer = LoopObserver(self._emitter, agent_id)
        stream = loop.run_stream(_task_message(task))
        try:
            async for event in stream:
                observer.feed(event)
                # The loop would otherwise spend one more LLM call letting the
                # model say goodbye after handing its findings over.
                if event.get("type") == "tool_end" and event.get("name") == submit.name:
                    break
        finally:
            await stream.aclose()

        return _to_finding(agent_id, task, submit, observer, loop)


def _task_message(task: SubagentTask) -> str:
    return f"Your task: {task.title}\n\n{task.prompt}"


def _to_finding(
    agent_id: str,
    task: SubagentTask,
    submit: SubmitFindingsTool,
    observer: LoopObserver,
    loop: AgentLoop,
) -> Finding:
    """Build the Finding, falling back to the loop's own text if the tool was skipped."""
    sources = dedupe([*submit.sources, *observer.sources])
    if submit.submitted and submit.summary:
        return Finding(
            agent_id=agent_id,
            title=task.title,
            status="ok",
            summary=submit.summary,
            sources=sources,
            gaps=submit.gaps,
        )

    salvaged = _last_assistant_text(loop)
    if salvaged:
        return Finding(
            agent_id=agent_id,
            title=task.title,
            status="ok",
            summary=salvaged,
            sources=sources,
            gaps="(this subagent never called submit_findings — text salvaged from its reply)",
        )
    return Finding(
        agent_id=agent_id,
        title=task.title,
        status="failed",
        sources=sources,
        error="the subagent produced no findings",
    )


def _last_assistant_text(loop: AgentLoop) -> str:
    for message in reversed(loop.messages):
        if message.get("role") == "assistant":
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
    return ""
