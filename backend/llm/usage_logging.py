"""LiteLLM usage/cost logging callback.

Single interception point for every LLM call (chat, research, streaming or
not, any provider) — see docs/agentchat-usage-tracking-design.md §6. Attached
once as ``litellm.callbacks`` in ``main.py``; never raises into the caller, a
lost usage row is preferable to a broken chat response.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import litellm
from litellm.integrations.custom_logger import CustomLogger

if TYPE_CHECKING:
    from store.usage_store import UsageStore

logger = logging.getLogger(__name__)


def _cached_tokens(usage: Any) -> int:
    """Cached-token count, normalized across OpenAI/Anthropic usage shapes."""
    details = getattr(usage, "prompt_tokens_details", None)
    cached = getattr(details, "cached_tokens", None) if details is not None else None
    if cached:
        return int(cached)
    # Anthropic-style: cache_read_input_tokens directly on the usage object.
    cached = getattr(usage, "cache_read_input_tokens", None)
    return int(cached) if cached else 0


def _manual_cost(
    store: "UsageStore", provider: str, model: str, prompt_tokens: int, completion_tokens: int, cached_tokens: int
) -> float | None:
    """Fallback pricing for models LiteLLM's price map doesn't know (e.g. Yandex)."""
    pricing = store.get_pricing(provider, model)
    if not pricing:
        return None
    input_rate = pricing.get("input_per_1m")
    output_rate = pricing.get("output_per_1m")
    if input_rate is None or output_rate is None:
        return None
    cached_rate = pricing.get("cached_per_1m") or 0.0
    billable_prompt = max(prompt_tokens - cached_tokens, 0)
    return (
        billable_prompt / 1_000_000 * input_rate
        + completion_tokens / 1_000_000 * output_rate
        + cached_tokens / 1_000_000 * cached_rate
    )


class UsageLogger(CustomLogger):
    """Writes one ``usage_log`` row per LiteLLM call."""

    def __init__(self, store: "UsageStore") -> None:
        self._store = store

    async def async_log_success_event(
        self, kwargs: dict[str, Any], response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        try:
            meta = (kwargs.get("litellm_params") or {}).get("metadata") or {}
            usage = getattr(response_obj, "usage", None)

            if usage is not None:
                prompt_t = int(getattr(usage, "prompt_tokens", 0) or 0)
                completion_t = int(getattr(usage, "completion_tokens", 0) or 0)
                cached_t = _cached_tokens(usage)
                source = "api"
            else:
                model_for_counter = str(kwargs.get("model", ""))
                messages = kwargs.get("messages") or []
                prompt_t = litellm.token_counter(model=model_for_counter, messages=messages)
                completion_t = 0
                text = ""
                choices = getattr(response_obj, "choices", None) or []
                if choices:
                    message = getattr(choices[0], "message", None)
                    text = getattr(message, "content", "") or ""
                if text:
                    completion_t = litellm.token_counter(model=model_for_counter, text=text)
                cached_t = 0
                source = "estimated"

            provider = str(meta.get("provider") or "unknown")
            model = str(meta.get("canonical_model") or kwargs.get("model") or "unknown")

            cost_usd = kwargs.get("response_cost")
            if cost_usd is None:
                try:
                    cost_usd = litellm.completion_cost(completion_response=response_obj)
                except Exception:  # noqa: BLE001 — model not in LiteLLM's price map
                    cost_usd = None
            if not cost_usd:
                cost_usd = _manual_cost(self._store, provider, model, prompt_t, completion_t, cached_t)

            latency_ms = None
            try:
                latency_ms = int((end_time - start_time).total_seconds() * 1000)
            except Exception:  # noqa: BLE001
                pass

            ts = None
            try:
                ts = int(start_time.timestamp())
            except Exception:  # noqa: BLE001
                pass

            breakdown = meta.get("breakdown")
            self._store.insert_usage(
                chat_id=meta.get("chat_id"),
                message_id=meta.get("message_id"),
                provider=provider,
                model=model,
                prompt_tokens=prompt_t,
                completion_tokens=completion_t,
                cached_tokens=cached_t,
                cost_usd=cost_usd,
                usage_source=source,
                latency_ms=latency_ms,
                context=str(meta.get("context") or "chat"),
                ts=ts,
                breakdown=breakdown if isinstance(breakdown, dict) else None,
            )
        except Exception as exc:  # noqa: BLE001 — a lost log row beats a broken chat
            logger.error("usage logging failed: %s", exc)
