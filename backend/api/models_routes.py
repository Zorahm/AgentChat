"""GET /api/models — list models discovered via each provider's /models endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from api.schemas.settings import ModelConfig

router = APIRouter(prefix="/models", tags=["models"])


class ProviderStatus(BaseModel):
    id: str
    status: str  # "ok" | "error" | "skipped"
    count: int
    error: str | None = None


class ModelsResponse(BaseModel):
    models: list[ModelConfig]
    providers: list[ProviderStatus]


@router.get("", response_model=ModelsResponse)
async def list_models(request: Request, refresh: bool = False) -> ModelsResponse:
    """Discover models from every enabled provider via their /models API.

    Set ``refresh=true`` to bypass the in-memory cache.
    """
    store = request.app.state.settings_store
    fetcher = request.app.state.models_fetcher

    providers = [p for p in store.list_providers()]
    results = await fetcher.fetch_all(providers, refresh=refresh)

    models: list[ModelConfig] = []
    statuses: list[ProviderStatus] = []
    for r in results:
        models.extend(r.models)
        statuses.append(ProviderStatus(
            id=r.provider_id,
            status=r.status,
            count=len(r.models),
            error=r.error,
        ))

    models.sort(key=lambda m: m.id)
    return ModelsResponse(models=models, providers=statuses)
