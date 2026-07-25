"""GET /api/usage/* — token/cost dashboard queries."""

from __future__ import annotations

import asyncio
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/usage", tags=["usage"])

Period = Literal["day", "week", "month", "all"]

_PERIOD_SECONDS: dict[str, int] = {
    "day": 24 * 3600,
    "week": 7 * 24 * 3600,
    "month": 30 * 24 * 3600,
}


def _from_ts(period: Period) -> int:
    if period == "all":
        return 0
    return int(time.time()) - _PERIOD_SECONDS[period]


# usage_log is the one table that grows without bound (a row per LLM call), so
# these aggregates are the SQLite queries worth keeping off the event loop —
# they would otherwise stall every concurrent chat stream for their duration.
# UsageStore guards its connection with a threading.Lock, so a worker thread is
# safe. The chat/settings stores stay synchronous: those queries are indexed
# point lookups over a bounded table.


@router.get("/summary")
async def summary(request: Request, period: Period = Query("month")) -> dict:
    store = request.app.state.usage_store
    return await asyncio.to_thread(store.summary, _from_ts(period))


@router.get("/by-model")
async def by_model(request: Request, period: Period = Query("month")) -> list[dict]:
    store = request.app.state.usage_store
    return await asyncio.to_thread(store.by_model, _from_ts(period))


@router.get("/daily")
async def daily(request: Request, period: Period = Query("month")) -> list[dict]:
    store = request.app.state.usage_store
    return await asyncio.to_thread(store.daily, _from_ts(period))


@router.get("/breakdown")
async def breakdown(request: Request, period: Period = Query("month")) -> dict | None:
    store = request.app.state.usage_store
    return await asyncio.to_thread(store.breakdown_summary, _from_ts(period))


class ModelPricing(BaseModel):
    """Manual per-1M-token rates for a model LiteLLM can't price."""

    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=256)
    input_per_1m: float = Field(ge=0)
    output_per_1m: float = Field(ge=0)
    cached_per_1m: float | None = Field(default=None, ge=0)


@router.get("/pricing")
async def list_pricing(request: Request) -> list[dict]:
    return request.app.state.usage_store.list_pricing()


@router.put("/pricing")
async def put_pricing(request: Request, body: ModelPricing) -> dict[str, str]:
    """Set manual rates for one model.

    Without this the ``model_pricing`` table had no writer at all, so
    ``_manual_cost`` (llm/usage_logging.py) could never fire and any model
    outside LiteLLM's price map reported an unknown cost forever.
    """
    request.app.state.usage_store.upsert_pricing(
        provider=body.provider,
        model=body.model,
        input_per_1m=body.input_per_1m,
        output_per_1m=body.output_per_1m,
        cached_per_1m=body.cached_per_1m,
        custom=True,
    )
    return {"status": "ok"}


@router.delete("/pricing")
async def delete_pricing(
    request: Request, provider: str = Query(...), model: str = Query(...)
) -> dict[str, str]:
    if not request.app.state.usage_store.delete_pricing(provider, model):
        raise HTTPException(status_code=404, detail="No manual pricing for that model")
    return {"status": "ok"}


@router.get("/top-chats")
async def top_chats(request: Request, period: Period = Query("month"), limit: int = Query(10, ge=1, le=50)) -> list[dict]:
    store = request.app.state.usage_store
    rows = await asyncio.to_thread(store.top_chats, _from_ts(period), limit)
    # list_chats() skips the (potentially large) root_json blob — cheaper than
    # get_chat() per row for what's just a title lookup.
    titles = {c["id"]: c["title"] for c in request.app.state.chat_store.list_chats()}
    return [{**row, "title": titles.get(row["chat_id"])} for row in rows]
