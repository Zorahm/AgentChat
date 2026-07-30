"""Tests for UsageStore aggregation queries and UsageLogger's callback."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from llm.usage_logging import UsageLogger  # noqa: E402
from store.usage_store import UsageStore  # noqa: E402


@pytest.fixture
def store(tmp_path: Path) -> UsageStore:
    return UsageStore(tmp_path / "usage.db")


def test_insert_and_summary(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="chat-1", message_id="msg-1", provider="anthropic", model="claude",
        prompt_tokens=100, completion_tokens=50, cached_tokens=10,
        cost_usd=0.01, usage_source="api", ts=now,
    )
    store.insert_usage(
        chat_id="chat-1", message_id="msg-1", provider="anthropic", model="claude",
        prompt_tokens=20, completion_tokens=5, cached_tokens=0,
        cost_usd=0.002, usage_source="api", ts=now, context="research",
    )

    summary = store.summary(now - 10)
    assert summary["calls"] == 2
    assert round(summary["cost"], 4) == 0.012
    assert summary["tokens"] == 175

    agg = store.get_message_usage("msg-1")
    assert agg is not None
    assert agg["prompt_tokens"] == 120
    assert agg["completion_tokens"] == 55
    assert agg["usage_source"] == "api"
    assert round(agg["cost_usd"], 4) == 0.012


def test_get_message_usage_unknown_returns_none(store: UsageStore) -> None:
    assert store.get_message_usage("nope") is None


def test_message_usage_null_cost_when_any_call_unpriced(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="c", message_id="m", provider="p", model="known",
        prompt_tokens=10, completion_tokens=10, cost_usd=0.01, usage_source="api", ts=now,
    )
    store.insert_usage(
        chat_id="c", message_id="m", provider="p", model="unknown",
        prompt_tokens=10, completion_tokens=10, cost_usd=None, usage_source="api", ts=now,
    )
    agg = store.get_message_usage("m")
    assert agg is not None
    assert agg["cost_usd"] is None


def test_by_model_and_chat_totals(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="chat-a", message_id="m1", provider="openai", model="gpt",
        prompt_tokens=1000, completion_tokens=200, cost_usd=1.5, usage_source="api", ts=now,
    )
    store.insert_usage(
        chat_id="chat-b", message_id="m2", provider="anthropic", model="claude",
        prompt_tokens=100, completion_tokens=20, cost_usd=0.2, usage_source="api", ts=now,
    )

    by_model = store.by_model(now - 10)
    assert by_model[0]["cost"] == 1.5  # ordered by cost desc

    totals = store.chat_totals(now - 10)
    assert [r["chat_id"] for r in totals] == ["chat-a", "chat-b"]


def test_chat_totals_are_unlimited_so_deleted_chats_cannot_crowd_out_live_ones(
    store: UsageStore,
) -> None:
    # The old query took the top 10 by cost. With a run of deleted chats above
    # them, live chats never reached the caller at all — the dashboard showed
    # nine "(deleted chat)" rows and one real one.
    now = int(time.time())
    for i in range(15):
        store.insert_usage(
            chat_id=f"chat-{i:02d}", message_id=f"m{i}", provider="openai", model="gpt",
            prompt_tokens=10, completion_tokens=1, cost_usd=1.0, usage_source="api", ts=now,
        )
    assert len(store.chat_totals(now - 10)) == 15


def test_chat_totals_break_cost_ties_by_call_count(store: UsageStore) -> None:
    # Local and free-tier models log cost 0, so without a tie-break the order
    # among them was whatever the group-by happened to emit.
    now = int(time.time())
    for chat, calls in (("quiet", 1), ("busy", 4)):
        for n in range(calls):
            store.insert_usage(
                chat_id=chat, message_id=f"{chat}-{n}", provider="local", model="nemotron",
                prompt_tokens=10, completion_tokens=1, cost_usd=0.0, usage_source="api", ts=now,
            )
    totals = store.chat_totals(now - 10)
    assert [r["chat_id"] for r in totals] == ["busy", "quiet"]


def test_chat_totals_skip_rows_with_no_chat(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="", message_id="m1", provider="openai", model="gpt",
        prompt_tokens=10, completion_tokens=1, cost_usd=1.0, usage_source="api", ts=now,
    )
    assert store.chat_totals(now - 10) == []


def test_daily_reports_tokens_even_when_a_provider_costs_nothing(store: UsageStore) -> None:
    # The dashboard chart plots these. Local and free-tier providers log a real
    # token count against cost 0, so a chart scaled by cost alone drew nothing
    # for them — they vanished from a chart whose legend still listed them.
    now = int(time.time())
    store.insert_usage(
        chat_id="c", message_id="m1", provider="anthropic", model="claude",
        prompt_tokens=100, completion_tokens=20, cost_usd=0.05, usage_source="api", ts=now,
    )
    store.insert_usage(
        chat_id="c", message_id="m2", provider="local", model="nemotron",
        prompt_tokens=7000, completion_tokens=200, cost_usd=0.0, usage_source="api", ts=now,
    )

    rows = {r["provider"]: r for r in store.daily(now - 10)}
    assert rows["local"]["cost"] == 0.0
    assert rows["local"]["tokens"] == 7200
    assert rows["anthropic"]["tokens"] == 120


@pytest.mark.asyncio
async def test_top_chats_endpoint_splits_live_from_deleted(store: UsageStore) -> None:
    from api.usage import top_chats

    now = int(time.time())
    for chat, cost in (("gone-1", 3.0), ("alive", 2.0), ("gone-2", 1.0)):
        store.insert_usage(
            chat_id=chat, message_id=f"m-{chat}", provider="openai", model="gpt",
            prompt_tokens=10, completion_tokens=1, cost_usd=cost, usage_source="api", ts=now,
        )

    chat_store = SimpleNamespace(list_chats=lambda: [{"id": "alive", "title": "Still here"}])
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(usage_store=store, chat_store=chat_store))
    )

    result = await top_chats(request, period="all", limit=10)  # type: ignore[arg-type]

    # The two most expensive chats are deleted; the live one must still show.
    assert [c["chat_id"] for c in result["chats"]] == ["alive"]
    assert result["chats"][0]["title"] == "Still here"
    assert [c["chat_id"] for c in result["deleted"]] == ["gone-1", "gone-2"]


def test_manual_pricing_fallback(store: UsageStore) -> None:
    store.upsert_pricing(provider="yandex", model="yandexgpt", input_per_1m=1.0, output_per_1m=2.0)
    pricing = store.get_pricing("yandex", "yandexgpt")
    assert pricing is not None
    assert pricing["input_per_1m"] == 1.0


@pytest.mark.asyncio
async def test_usage_logger_writes_row_from_response_usage(store: UsageStore) -> None:
    logger = UsageLogger(store)
    kwargs = {
        "model": "openai/gpt-4o",
        "litellm_params": {
            "metadata": {
                "chat_id": "chat-x",
                "message_id": "msg-x",
                "provider": "openai",
                "canonical_model": "openai/gpt-4o",
                "context": "chat",
            }
        },
        "response_cost": 0.0042,
    }
    response_obj = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=30, completion_tokens=10, prompt_tokens_details=None),
        choices=[],
    )

    class _T:
        def timestamp(self) -> float:
            return time.time()

        def __sub__(self, other: "_T") -> SimpleNamespace:
            return SimpleNamespace(total_seconds=lambda: 0.5)

    await logger.async_log_success_event(kwargs, response_obj, _T(), _T())

    agg = store.get_message_usage("msg-x")
    assert agg is not None
    assert agg["prompt_tokens"] == 30
    assert agg["completion_tokens"] == 10
    assert agg["cost_usd"] == 0.0042
    assert agg["usage_source"] == "api"


@pytest.mark.asyncio
async def test_usage_logger_never_raises_on_bad_input(store: UsageStore) -> None:
    logger = UsageLogger(store)
    # Missing everything a real call would have — must not raise.
    await logger.async_log_success_event({}, None, None, None)


def test_breakdown_aggregated_per_message(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="c", message_id="m", provider="p", model="model",
        prompt_tokens=100, completion_tokens=10, cost_usd=0.01, usage_source="api", ts=now,
        breakdown={"system": 60, "tools": 20, "history": 10, "message": 10},
    )
    # A tool round-trip within the same turn — the system prompt + tools are
    # resent, so summing (not averaging) matches what was actually billed.
    store.insert_usage(
        chat_id="c", message_id="m", provider="p", model="model",
        prompt_tokens=95, completion_tokens=5, cost_usd=0.009, usage_source="api", ts=now,
        breakdown={"system": 60, "tools": 20, "history": 15, "message": 0},
    )

    agg = store.get_message_usage("m")
    assert agg is not None
    assert agg["breakdown"] == {"system": 120, "tools": 40, "history": 25, "message": 10}


def test_breakdown_summary_across_period(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="c1", message_id="m1", provider="p", model="model",
        prompt_tokens=10, completion_tokens=1, cost_usd=0.001, usage_source="api", ts=now,
        breakdown={"system": 6, "tools": 2, "history": 1, "message": 1},
    )
    store.insert_usage(
        chat_id="c2", message_id="m2", provider="p", model="model",
        prompt_tokens=20, completion_tokens=1, cost_usd=0.002, usage_source="api", ts=now,
        breakdown={"system": 6, "tools": 2, "history": 10, "message": 2},
    )

    summary = store.breakdown_summary(now - 10)
    assert summary == {"system": 12, "tools": 4, "history": 11, "message": 3}


def test_breakdown_none_when_no_rows_have_it(store: UsageStore) -> None:
    now = int(time.time())
    store.insert_usage(
        chat_id="c", message_id="m", provider="p", model="model",
        prompt_tokens=10, completion_tokens=1, cost_usd=0.001, usage_source="api", ts=now,
    )
    assert store.get_message_usage("m")["breakdown"] is None
    assert store.breakdown_summary(now - 10) is None


@pytest.mark.asyncio
async def test_usage_logger_passes_through_breakdown(store: UsageStore) -> None:
    logger = UsageLogger(store)
    kwargs = {
        "model": "openai/gpt-4o",
        "litellm_params": {
            "metadata": {
                "chat_id": "chat-y",
                "message_id": "msg-y",
                "provider": "openai",
                "canonical_model": "openai/gpt-4o",
                "context": "chat",
                "breakdown": {"system": 500, "tools": 100, "history": 0, "message": 5},
            }
        },
        "response_cost": 0.01,
    }
    response_obj = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=605, completion_tokens=20, prompt_tokens_details=None),
        choices=[],
    )

    class _T:
        def timestamp(self) -> float:
            return time.time()

        def __sub__(self, other: "_T") -> SimpleNamespace:
            return SimpleNamespace(total_seconds=lambda: 0.5)

    await logger.async_log_success_event(kwargs, response_obj, _T(), _T())

    agg = store.get_message_usage("msg-y")
    assert agg is not None
    assert agg["breakdown"] == {"system": 500, "tools": 100, "history": 0, "message": 5}
