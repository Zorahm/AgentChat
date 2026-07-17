"""GET /api/usage/* — token/cost dashboard queries."""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Query, Request

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


@router.get("/summary")
async def summary(request: Request, period: Period = Query("month")) -> dict:
    return request.app.state.usage_store.summary(_from_ts(period))


@router.get("/by-model")
async def by_model(request: Request, period: Period = Query("month")) -> list[dict]:
    return request.app.state.usage_store.by_model(_from_ts(period))


@router.get("/daily")
async def daily(request: Request, period: Period = Query("month")) -> list[dict]:
    return request.app.state.usage_store.daily(_from_ts(period))


@router.get("/breakdown")
async def breakdown(request: Request, period: Period = Query("month")) -> dict | None:
    return request.app.state.usage_store.breakdown_summary(_from_ts(period))


@router.get("/top-chats")
async def top_chats(request: Request, period: Period = Query("month"), limit: int = Query(10, ge=1, le=50)) -> list[dict]:
    rows = request.app.state.usage_store.top_chats(_from_ts(period), limit)
    # list_chats() skips the (potentially large) root_json blob — cheaper than
    # get_chat() per row for what's just a title lookup.
    titles = {c["id"]: c["title"] for c in request.app.state.chat_store.list_chats()}
    return [{**row, "title": titles.get(row["chat_id"])} for row in rows]
