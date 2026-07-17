"""research tool — deep, multi-step web research producing a cited report.md.

Registered per-request only when the chat's research toggle is on. Internally it
drives a :class:`~agent.research_runner.ResearchRunner` (an inner agent loop over
web_search + web_fetch), writes the synthesized report to ``report.md`` in the
chat folder, and hands the path back so the MAIN agent can surface it via
``present_files``. Progress lines stream live: the outer loop drains
``progress_queue`` and forwards it as ``tool_chunk`` (see ``agent.loop``).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from agent.research_runner import ResearchResult, ResearchRunner
from agent.sandbox import SandboxPolicy
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.write_file import WriteFileTool, _resolve_write_path
from web_search.service import WebSearchService

if TYPE_CHECKING:
    from store.settings_store import SettingsStore


class ResearchTool(BaseTool):
    """Run deep web research and save a cited report."""

    name = "research"
    description = (
        "Run deep, multi-step web research on a topic and produce a cited markdown "
        "report saved as report.md. Use for questions that need thorough, "
        "source-backed investigation across several web sources (current events, "
        "comparisons, market/literature scans). It plans queries, searches, reads "
        "pages, and synthesizes a structured report. When it returns, call "
        "present_files(['report.md']) to show the report, then give a brief summary."
    )
    # Signals agent.loop to run execute() as a task and forward progress_queue
    # lines as tool_chunk events while it runs.
    streams_progress = True

    def __init__(
        self,
        *,
        store: SettingsStore,
        web_search_service: WebSearchService,
        provider_id: str,
        model: str,
        lite_model: str,
        api_key: str | None,
        api_base: str | None,
        extra_headers: dict[str, str] | None,
        usage_metadata: dict[str, object] | None = None,
    ) -> None:
        self._store = store
        self._service = web_search_service
        self._provider_id = provider_id
        self._model = model
        self._lite_model = lite_model
        self._api_key = api_key
        self._api_base = api_base
        self._extra_headers = extra_headers
        self._usage_metadata = usage_metadata
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)
        # Carries structured progress events (plan/search/sources/read/done)
        # that agent.loop forwards to the UI as tool_progress.
        self.progress_queue: "asyncio.Queue[dict[str, object]]" = asyncio.Queue()

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "The research topic or question to investigate.",
                        },
                        "depth": {
                            "type": "integer",
                            "description": (
                                "How deep to go: 1=focused, 2=thorough (default), "
                                "3=exhaustive. Higher depth = more searches and a longer run."
                            ),
                        },
                        "language": {
                            "type": "string",
                            "description": (
                                "Language to write the report in — ALWAYS pass the "
                                "user's language (the language of their messages), e.g. "
                                "'Russian', 'English'. The report's prose follows it."
                            ),
                        },
                    },
                    "required": ["topic"],
                },
            )
        )

    async def execute(
        self,
        topic: str | None = None,
        query: str | None = None,
        depth: int = 2,
        language: str | None = None,
        **_: object,
    ) -> str:
        subject = (topic or query or "").strip()
        if not subject:
            return "Error: research needs a 'topic' to investigate."
        try:
            depth_int = int(depth)
        except (TypeError, ValueError):
            depth_int = 2

        runner = ResearchRunner(
            store=self._store,
            web_search_service=self._service,
            provider_id=self._provider_id,
            model=self._model,
            lite_model=self._lite_model,
            api_key=self._api_key,
            api_base=self._api_base,
            extra_headers=self._extra_headers,
            policy=self._policy,
            progress_queue=self.progress_queue,
            usage_metadata=(
                {**self._usage_metadata, "context": "research"} if self._usage_metadata else None
            ),
        )
        result: ResearchResult = await runner.run(subject, depth_int, (language or "").strip())
        if not result.ok:
            return result.message

        # Resolve to an ABSOLUTE path and hand it back. The UI builds the file
        # card from the path the model passes to present_files verbatim, so a
        # relative "report.md" would resolve against the backend's cwd and 404
        # ("File unavailable"). Make the model present the absolute path.
        report_path = _resolve_write_path("report.md", self._policy) or "report.md"
        writer = WriteFileTool()
        writer.set_policy(self._policy)
        write_res = await writer.execute(path=report_path, content=result.report)
        if write_res.startswith("Error"):
            # Couldn't save the file — hand the full report back inline so the
            # work isn't lost; the agent can still relay it.
            return (
                f"Research complete, but saving the report failed ({write_res}).\n\n"
                f"{result.report}"
            )

        return (
            f"Research complete — {write_res}.\n"
            f"Next: call present_files with this EXACT absolute path — "
            f"present_files(paths=['{report_path}']) — to show the report to the user, "
            "then give a 2-3 sentence summary of the findings.\n\n"
            f"Report abstract:\n{_abstract(result.report)}"
        )


def _abstract(report: str, limit: int = 600) -> str:
    """A short lead excerpt of the report for the tool result."""
    text = report.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + " …"
