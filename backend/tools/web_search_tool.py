"""Web search tool — local function-tool backed by Tavily or SearXNG.

Registered per-request only when the resolved web-search mode is a local
backend. Native (provider-side) search does not use this tool.
"""

from __future__ import annotations

from typing import Any

from tools.base import BaseTool, ToolDefinition, ToolSchema
from web_search.config import EffectiveBackend, WebSearchConfig
from web_search.service import WebSearchService


class WebSearchTool(BaseTool):
    """Search the web for current or external information."""

    name = "web_search"
    description = (
        "Search the web for current, real-time, or external information. "
        "Use this ONLY when the answer needs up-to-date facts, recent events, "
        "or information not in your training data — do not call it for things "
        "you already know. Returns a ranked list of results (title, URL, snippet)."
    )

    def __init__(
        self,
        service: WebSearchService,
        config: WebSearchConfig,
        backend: EffectiveBackend,
    ) -> None:
        self._service = service
        self._config = config
        self._backend = backend

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query.",
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results (1-10, default 5).",
                        },
                    },
                    "required": ["query"],
                },
            )
        )

    async def execute(self, query: str, max_results: int = 5, **_: Any) -> str:
        capped = max(1, min(int(max_results), 10))
        try:
            results = await self._service.search(
                query, self._config, self._backend, capped
            )
        except Exception as exc:  # noqa: BLE001 — surface backend errors to the model
            return f"[web_search error] {exc}"

        if not results:
            return f'Web search for "{query}" returned no results.'

        lines = [f'Web search results for "{query}" — {len(results)} result(s):', ""]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r.title}")
            if r.url:
                lines.append(f"   {r.url}")
            if r.snippet:
                lines.append(f"   {r.snippet}")
            lines.append("")
        return "\n".join(lines).rstrip()
