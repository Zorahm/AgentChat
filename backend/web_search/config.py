"""Pydantic models and types for web search configuration."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# Requested mode. "auto" resolves the fallback chain at runtime; the others
# force a specific backend (falling back down the chain if it is unavailable).
WebSearchMode = Literal["auto", "native", "litellm", "searxng"]

# Effective backend actually used for a turn. "none" means web search was
# requested but no backend was available.
EffectiveBackend = Literal["native", "litellm", "searxng", "none"]


class SearchResult(BaseModel):
    """A single web search hit. Crosses the service → tool boundary."""

    title: str
    url: str
    snippet: str = ""


class WebSearchConfig(BaseModel):
    """Per-request web search configuration, assembled from settings + env.

    The service is a long-lived singleton (it owns the native-capability
    cache); this config is cheap and rebuilt each request so changes to the
    SearXNG URL or the presence of the Tavily key take effect immediately.
    """

    tavily_api_key: str | None = Field(default=None)
    searxng_url: str | None = Field(default=None)
    # Default mode the UI offers when the user hasn't forced one for a chat.
    default_mode: WebSearchMode = "auto"

    @property
    def tavily_available(self) -> bool:
        return bool(self.tavily_api_key)

    @property
    def searxng_available(self) -> bool:
        return bool(self.searxng_url)


class ModeStatus(BaseModel):
    """Availability of one mode, surfaced by GET /api/config/web-search."""

    id: WebSearchMode
    available: bool
    # Short human reason, e.g. "TAVILY_API_KEY not set" or "depends on model".
    reason: str
