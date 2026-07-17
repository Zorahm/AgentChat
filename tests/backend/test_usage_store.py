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


def test_by_model_and_top_chats(store: UsageStore) -> None:
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

    top = store.top_chats(now - 10)
    assert top[0]["chat_id"] == "chat-a"


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
