"""Web search service — backend-agnostic search client + mode resolver.

Knows nothing about FastAPI. The agent loop (native tools) and the
``web_search`` function-tool (local backends) both go through here.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from web_search.config import (
    EffectiveBackend,
    ModeStatus,
    SearchResult,
    WebSearchConfig,
    WebSearchMode,
)

# Native server-side tool descriptors, appended to the LiteLLM ``tools`` array.
# The provider runs the search itself — we never execute these locally.
_ANTHROPIC_NATIVE_TOOL: dict[str, object] = {"type": "web_search_20250305", "name": "web_search"}
_OPENAI_NATIVE_TOOL: dict[str, object] = {"type": "web_search_preview"}

# Per-(provider, model) native-capability cache TTL.
_NATIVE_TTL_SECONDS = 3600.0


@dataclass(frozen=True)
class ResolvedWebSearch:
    """Outcome of resolving the fallback chain for one turn."""

    effective: EffectiveBackend
    # Native server-tool dict to append to the LiteLLM tools array (native only).
    native_tool: dict[str, object] | None = None


@dataclass
class _NativeProbe:
    tool: dict[str, object] | None
    # True only when capability is positively confirmed (e.g. Anthropic
    # capabilities API). Optimistic guesses (OpenAI) are not confident, so
    # "auto" mode never picks them — only an explicit "native" request does.
    confident: bool


class WebSearchService:
    """Long-lived singleton. Owns the native-capability cache.

    ``capability_lookup(model_id)`` returns the model's native web-search
    capability flag (True/False) or None when unknown. It is injected so the
    service stays decoupled from the models fetcher.
    """

    def __init__(
        self,
        capability_lookup: Callable[[str], bool | None] | None = None,
    ) -> None:
        self._capability_lookup = capability_lookup
        # (provider_id, model_id) -> (_NativeProbe, expires_at)
        self._native_cache: dict[tuple[str, str], tuple[_NativeProbe, float]] = {}
        # (provider_id, model_id) pairs proven unsupported at request time
        # (graceful fallback after a provider rejects the native tool).
        self._unsupported: dict[tuple[str, str], float] = {}

    # ── native detection ────────────────────────────────────────────────

    def _probe_native(self, provider_id: str, model_id: str) -> _NativeProbe:
        key = (provider_id, model_id)
        now = time.time()

        unsupported_until = self._unsupported.get(key)
        if unsupported_until is not None and now < unsupported_until:
            return _NativeProbe(tool=None, confident=True)

        cached = self._native_cache.get(key)
        if cached is not None and now < cached[1]:
            return cached[0]

        probe = self._compute_native(provider_id, model_id)
        self._native_cache[key] = (probe, now + _NATIVE_TTL_SECONDS)
        return probe

    def _compute_native(self, provider_id: str, model_id: str) -> _NativeProbe:
        if provider_id == "anthropic":
            cap = self._capability_lookup(model_id) if self._capability_lookup else None
            if cap is True:
                return _NativeProbe(tool=_ANTHROPIC_NATIVE_TOOL, confident=True)
            # Capability absent/unknown → don't auto-engage, but allow a forced
            # native request to try it (Anthropic's API may not expose the flag).
            return _NativeProbe(tool=_ANTHROPIC_NATIVE_TOOL, confident=False)
        if provider_id == "openai":
            # /v1/models exposes no capabilities — optimistic, low confidence.
            return _NativeProbe(tool=_OPENAI_NATIVE_TOOL, confident=False)
        return _NativeProbe(tool=None, confident=False)

    def get_native_tool(self, provider_id: str, model_id: str) -> dict[str, object] | None:
        """Return the provider's native web-search tool dict, or None.

        Per spec: a tool object if native search is supported, else None.
        Cached per-model (TTL 1h or until sidecar restart).
        """
        return self._probe_native(provider_id, model_id).tool

    def mark_native_unsupported(self, provider_id: str, model_id: str) -> None:
        """Record that the provider rejected the native tool, so the next turn
        falls back down the chain instead of failing again."""
        self._unsupported[(provider_id, model_id)] = time.time() + _NATIVE_TTL_SECONDS

    # ── mode resolution ─────────────────────────────────────────────────

    def resolve(
        self,
        provider_id: str,
        model_id: str,
        requested_mode: WebSearchMode,
        config: WebSearchConfig,
    ) -> ResolvedWebSearch:
        """Resolve the fallback chain native → litellm → searxng → none.

        A forced mode is tried first, then the remaining chain. In "auto",
        native is only chosen when confidently supported.
        """
        probe = self._probe_native(provider_id, model_id)
        native_ok = probe.tool is not None and (
            probe.confident or requested_mode == "native"
        )

        def available(mode: WebSearchMode) -> bool:
            if mode == "native":
                return native_ok
            if mode == "litellm":
                return config.tavily_available
            if mode == "searxng":
                return config.searxng_available
            return False

        order: list[WebSearchMode] = ["native", "litellm", "searxng"]
        if requested_mode in order:
            order.remove(requested_mode)
            order.insert(0, requested_mode)

        for mode in order:
            if available(mode):
                if mode == "native":
                    return ResolvedWebSearch(effective="native", native_tool=probe.tool)
                return ResolvedWebSearch(effective=mode)
        return ResolvedWebSearch(effective="none")

    def available_modes(
        self,
        config: WebSearchConfig,
    ) -> list[ModeStatus]:
        """Status of every mode for GET /api/config/web-search."""
        return [
            ModeStatus(
                id="native",
                available=True,
                reason="depends on model",
            ),
            ModeStatus(
                id="litellm",
                available=config.tavily_available,
                reason="ready (Tavily)" if config.tavily_available else "TAVILY_API_KEY not set",
            ),
            ModeStatus(
                id="searxng",
                available=config.searxng_available,
                reason="ready" if config.searxng_available else "SEARXNG_URL not set",
            ),
        ]

    # ── search execution (local backends) ───────────────────────────────

    async def search(
        self,
        query: str,
        config: WebSearchConfig,
        backend: EffectiveBackend,
        max_results: int = 5,
    ) -> list[SearchResult]:
        """Run a search against the chosen local backend.

        Only ``litellm`` (Tavily) and ``searxng`` are valid here; ``native`` is
        handled provider-side and never reaches this method.
        """
        if backend == "litellm":
            return await self._search_tavily(query, config, max_results)
        if backend == "searxng":
            return await self._search_searxng(query, config, max_results)
        raise ValueError(f"search() called with non-local backend {backend!r}")

    async def _search_tavily(
        self, query: str, config: WebSearchConfig, max_results: int
    ) -> list[SearchResult]:
        if not config.tavily_api_key:
            raise RuntimeError("Tavily backend selected but TAVILY_API_KEY is not set.")
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": config.tavily_api_key,
                    "query": query,
                    "max_results": max_results,
                    "search_depth": "basic",
                },
            )
            resp.raise_for_status()
            data = resp.json()
        out: list[SearchResult] = []
        for r in data.get("results", [])[:max_results]:
            if not isinstance(r, dict):
                continue
            out.append(
                SearchResult(
                    title=str(r.get("title") or r.get("url") or "result"),
                    url=str(r.get("url") or ""),
                    snippet=str(r.get("content") or "")[:500],
                )
            )
        return out

    async def _search_searxng(
        self, query: str, config: WebSearchConfig, max_results: int
    ) -> list[SearchResult]:
        if not config.searxng_url:
            raise RuntimeError("SearXNG backend selected but SEARXNG_URL is not set.")
        base = config.searxng_url.rstrip("/")
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f"{base}/search",
                params={"q": query, "format": "json"},
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()
        out: list[SearchResult] = []
        for r in data.get("results", [])[:max_results]:
            if not isinstance(r, dict):
                continue
            out.append(
                SearchResult(
                    title=str(r.get("title") or r.get("url") or "result"),
                    url=str(r.get("url") or ""),
                    snippet=str(r.get("content") or "")[:500],
                )
            )
        return out
