"""ResearchRunner — drive an inner ``AgentLoop`` to research a topic, return a report.

Reuses the main agent loop with a *restricted* tool registry (web_search +
web_fetch), the research system prompt, a configurable model, and a capped
iteration budget. Progress lines are pushed onto an optional queue so the outer
chat loop can stream them to the UI as ``tool_chunk`` events.

The runner never raises into its caller — every failure (no web backend, provider
error, empty output) comes back as a :class:`ResearchResult` with ``ok=False``.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agent.config import AgentConfig
from agent.loop import AgentLoop
from agent.research_prompt import build_research_system_prompt
from agent.sandbox import SandboxPolicy
from llm.client import LLMClient
from tools.registry import ToolRegistry
from tools.web_fetch_tool import WebFetchTool
from tools.web_search_tool import WebSearchTool
from web_search.service import WebSearchService

if TYPE_CHECKING:
    from store.settings_store import SettingsStore

_NO_BACKEND_MSG = (
    "Research needs web access but no search backend is available. Use a model "
    "with native web search, or configure Tavily (TAVILY_API_KEY) or SearXNG "
    "(SEARXNG_URL / Settings → Providers), then try again."
)

_URL_RE = re.compile(r"https?://[^\s)\]<>\"']+")


def _extract_urls(text: str) -> list[str]:
    """Pull unique URLs out of a web_search result blob (order-preserving)."""
    out: list[str] = []
    for raw in _URL_RE.findall(text):
        url = raw.rstrip(".,;)")
        if url not in out:
            out.append(url)
    return out


def _clean_plan(text: str) -> str:
    """First line of the model's plan, with the leading 'Plan:' label stripped."""
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    first = re.sub(r"^(plan|план)\s*[:\-–]\s*", "", first, flags=re.IGNORECASE)
    return first[:240]


@dataclass
class ResearchResult:
    """Outcome of one research run."""

    ok: bool
    report: str = ""
    message: str = ""


class ResearchRunner:
    """One-shot research orchestrator. Construct fresh per tool call."""

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
        policy: SandboxPolicy,
        progress_queue: "asyncio.Queue[dict[str, Any]] | None" = None,
    ) -> None:
        self._store = store
        self._service = web_search_service
        self._provider_id = provider_id
        self._model = model
        self._lite_model = lite_model
        self._api_key = api_key
        self._api_base = api_base
        self._extra_headers = extra_headers
        self._policy = policy
        self._queue = progress_queue

    def _emit(self, event: dict[str, Any]) -> None:
        """Push a structured progress event to the queue for the UI timeline."""
        if self._queue is not None:
            self._queue.put_nowait(event)

    async def run(self, topic: str, depth: int, language: str = "") -> ResearchResult:
        # Lazy import keeps store.settings_store off the module-import path
        # (it pulls api.schemas → api.router → api.chat, which would cycle back
        # here at import time).
        from store.settings_store import build_web_search_config

        depth = max(1, min(int(depth), 3))

        # Resolve a web backend independently of the chat's web-search toggle —
        # research is pointless without web access.
        ws_config = build_web_search_config(self._store)
        resolved = self._service.resolve(
            self._provider_id, self._model, self._store.web_search_mode, ws_config
        )
        effective = resolved.effective
        native_tool = resolved.native_tool if effective == "native" else None
        if effective == "none" and native_tool is None:
            return ResearchResult(ok=False, message=_NO_BACKEND_MSG)

        # Restricted, per-call registry: the inner agent can only search + fetch.
        registry = ToolRegistry()
        registry.register(WebFetchTool())
        if effective in ("litellm", "searxng"):
            registry.register(WebSearchTool(self._service, ws_config, effective))

        config = AgentConfig(
            model=self._lite_model,
            system_prompt=build_research_system_prompt(),
            api_key=self._api_key,
            api_base=self._api_base,
            temperature=self._store.temperature,
            max_iterations=min(depth * 4 + 2, 20),
            extra_headers=self._extra_headers,
        )
        llm = LLMClient(
            api_base=self._api_base,
            api_key=self._api_key,
            extra_headers=self._extra_headers,
        )
        loop = AgentLoop(
            config=config,
            tools=registry,
            llm=llm,
            policy=self._policy,
            extra_tools=[native_tool] if native_tool else None,
        )

        seed = self._build_seed(topic, depth, language)
        # State for the live timeline. Queries/urls stream in char-by-char, so we
        # accumulate the LATEST value per call id and only emit the node at
        # tool_end — that guarantees the FULL query, never a truncated prefix.
        names: dict[str, str] = {}
        queries: dict[str, str] = {}
        fetch_urls: dict[str, str] = {}
        plan_text = ""
        plan_emitted = False

        def emit_plan() -> None:
            nonlocal plan_emitted
            if plan_emitted:
                return
            plan_emitted = True
            self._emit({"kind": "plan", "text": _clean_plan(plan_text)})

        try:
            async for ev in loop.run_stream(seed):
                etype = ev.get("type")
                cid = str(ev.get("id", ""))
                if etype == "token" and not plan_emitted:
                    # The model's first visible line is its `Plan:` line.
                    plan_text += str(ev.get("content", ""))
                elif etype == "tool_start":
                    name = str(ev.get("name", ""))
                    names[cid] = name
                    emit_plan()  # the model has stopped planning and started acting
                    inp = ev.get("input") or {}
                    if name == "web_search":
                        q = str(inp.get("query", "")).strip()
                        if q:
                            queries[cid] = q
                    elif name == "web_fetch":
                        u = str(inp.get("url", "")).strip()
                        if u:
                            fetch_urls[cid] = u
                elif etype == "tool_input":
                    inp = ev.get("input") or {}
                    if names.get(cid) == "web_search":
                        q = str(inp.get("query", "")).strip()
                        if q:
                            queries[cid] = q
                    elif names.get(cid) == "web_fetch":
                        u = str(inp.get("url", "")).strip()
                        if u:
                            fetch_urls[cid] = u
                elif etype == "tool_end":
                    name = ev.get("name")
                    if name == "web_search":
                        self._emit({"kind": "search", "query": queries.get(cid, ""), "callId": cid})
                        urls = _extract_urls(str(ev.get("output", "")))
                        if urls:
                            self._emit({"kind": "sources", "urls": urls, "callId": cid})
                    elif name == "web_fetch" and fetch_urls.get(cid):
                        self._emit({"kind": "read", "url": fetch_urls[cid]})
            emit_plan()  # fallback: model produced a report with no tool calls
        except Exception as exc:  # noqa: BLE001 — never raise into the tool
            return ResearchResult(ok=False, message=f"Research failed: {exc}")

        report = self._harvest(loop)
        if not report.strip():
            return ResearchResult(
                ok=False,
                message="Research ran but produced no report (the model returned no text).",
            )
        self._emit({"kind": "done", "title": self._title_from(report, topic)})
        return ResearchResult(ok=True, report=report)

    @staticmethod
    def _build_seed(topic: str, depth: int, language: str) -> str:
        breadth = {1: "a focused", 2: "a thorough", 3: "an exhaustive"}.get(depth, "a thorough")
        lang_line = (
            f" Write the entire report in {language}."
            if language.strip()
            else " Write the report in the same language as the topic above."
        )
        return (
            f"Research topic: {topic}\n\n"
            f"Do {breadth} investigation using your tools, then write the final "
            f"markdown report exactly as specified in your instructions.{lang_line}"
        )

    @staticmethod
    def _title_from(report: str, topic: str) -> str:
        """Card title: the report's H1 if present, else a trimmed topic."""
        for line in report.splitlines():
            s = line.strip()
            if s.startswith("# "):
                return s[2:].strip()[:120]
        return topic.strip()[:120]

    @staticmethod
    def _harvest(loop: AgentLoop) -> str:
        """Return the last assistant message's text (the synthesized report)."""
        for msg in reversed(loop.messages):
            if msg.get("role") == "assistant":
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content
        return ""
