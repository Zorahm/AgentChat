"""GET /api/config/* — runtime capability/config probes for the UI."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from web_search.config import ModeStatus

router = APIRouter(prefix="/config", tags=["config"])


class WebSearchConfigInfo(BaseModel):
    """Web search availability surfaced to the settings + chat UI."""

    default_mode: str
    modes: list[ModeStatus]


@router.get("/web-search", response_model=WebSearchConfigInfo)
async def web_search_config(request: Request) -> WebSearchConfigInfo:
    """Report which web search modes are available and the configured default."""
    from store.settings_store import build_web_search_config

    store = request.app.state.settings_store
    service = request.app.state.web_search_service
    config = build_web_search_config(store)
    return WebSearchConfigInfo(
        default_mode=config.default_mode,
        modes=service.available_modes(config),
    )
