"""Ollama offline model management router."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/offline", tags=["offline"])

OLLAMA_BASE = "http://127.0.0.1:11434"

class PullRequest(BaseModel):
    name: str

@router.get("/status")
async def get_status() -> dict[str, bool]:
    """Check if Ollama is running locally."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{OLLAMA_BASE}/")
            if resp.status_code == 200:
                return {"running": True}
    except Exception:
        pass
    return {"running": False}

@router.post("/pull")
async def pull_model(request: Request, body: PullRequest) -> StreamingResponse:
    """Stream model download progress from Ollama."""
    # We yield the raw NDJSON bytes from Ollama.
    async def _stream():
        async with httpx.AsyncClient(timeout=None) as client:
            try:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/pull",
                    json={"name": body.name, "stream": True}
                ) as response:
                    if response.status_code != 200:
                        yield b'{"error": "Failed to pull model"}\n'
                        return
                    async for chunk in response.aiter_bytes():
                        yield chunk
            except Exception as e:
                yield f'{{"error": "{str(e)}"}}\n'.encode("utf-8")

    return StreamingResponse(_stream(), media_type="application/x-ndjson")

@router.delete("/{model_name:path}")
async def delete_model(model_name: str) -> dict[str, str]:
    """Delete a downloaded model from Ollama."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.request(
                "DELETE",
                f"{OLLAMA_BASE}/api/delete",
                json={"name": model_name}
            )
            if resp.status_code == 200:
                return {"status": "ok"}
            else:
                raise HTTPException(status_code=resp.status_code, detail="Failed to delete model")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
