"""Web search module — native (provider-side) and local (Tavily / SearXNG) backends.

The package is framework-agnostic: it knows nothing about FastAPI. ``config``
holds the Pydantic models, ``service`` holds the search client + mode resolver.
"""

from __future__ import annotations

from web_search.config import (
    SearchResult,
    WebSearchConfig,
    WebSearchMode,
    ModeStatus,
)
from web_search.service import ResolvedWebSearch, WebSearchService

__all__ = [
    "SearchResult",
    "WebSearchConfig",
    "WebSearchMode",
    "ModeStatus",
    "ResolvedWebSearch",
    "WebSearchService",
]
