"""Settings API — providers, default model.  Phase 3 (multi-provider)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from api.models import ProviderCreate, ProviderUpdate, SettingsData, SettingsUpdate

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=SettingsData)
async def get_settings(request: Request) -> SettingsData:
    """Return all providers and global settings."""
    return request.app.state.settings_store.get()


@router.put("", response_model=SettingsData)
async def update_settings(request: Request, body: SettingsUpdate) -> SettingsData:
    """Update global settings (model, temperature, iterations)."""
    return request.app.state.settings_store.update(body)


@router.put("/providers/{provider_id}")
async def update_provider(
    request: Request, provider_id: str, body: ProviderUpdate
) -> dict[str, object]:
    """Update a single provider's key, base URL, or enabled flag."""
    try:
        provider = request.app.state.settings_store.update_provider(provider_id, body)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"status": "ok", "provider": provider.model_dump()}


@router.post("/providers")
async def add_provider(request: Request, body: ProviderCreate) -> dict[str, object]:
    """Add a custom OpenAI-compatible provider."""
    try:
        provider = request.app.state.settings_store.add_provider(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "ok", "provider": provider.model_dump()}


@router.delete("/providers/{provider_id}")
async def delete_provider(request: Request, provider_id: str) -> dict[str, str]:
    """Remove a custom provider. Built-in providers cannot be removed."""
    try:
        request.app.state.settings_store.remove_provider(provider_id)
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "Unknown" in msg else 400
        raise HTTPException(status_code=code, detail=msg)
    return {"status": "ok"}
