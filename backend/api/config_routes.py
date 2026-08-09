"""GET /api/config/* — runtime capability/config probes for the UI."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from images.config import BackendStatus
from web_search.config import ModeStatus

router = APIRouter(prefix="/config", tags=["config"])


class WebSearchConfigInfo(BaseModel):
    """Web search availability surfaced to the settings + chat UI."""

    default_mode: str
    modes: list[ModeStatus]


class ImageConfigInfo(BaseModel):
    """Image-generation availability surfaced to the settings UI."""

    # The user's chosen backend (auto|api|a1111|comfy).
    backend: str
    # What "auto" would actually pick right now — "none" when nothing is set up.
    effective: str
    backends: list[BackendStatus]


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


@router.get("/images", response_model=ImageConfigInfo)
async def image_config(request: Request) -> ImageConfigInfo:
    """Report which image backends are configured and which one would run."""
    from store.settings_store import build_image_config

    store = request.app.state.settings_store
    service = request.app.state.image_service
    config = build_image_config(store)
    return ImageConfigInfo(
        backend=config.backend,
        effective=service.resolve(config, config.backend),
        backends=service.available_backends(config),
    )
