"""Shared helper: re-tag a model id for LiteLLM's OpenAI-compatible client.

LiteLLM only routes by a fixed set of native provider prefixes. OpenAI-
compatible endpoints — user-added custom providers (LM Studio, vLLM, …), the
opencode built-in, yandex, and gemini pointed at its OpenAI-compatible endpoint
— carry OUR provider id as the prefix, which LiteLLM can't resolve ("LLM
Provider NOT provided"). Strip our prefix and re-tag as ``openai/<model>`` so
LiteLLM uses its OpenAI-compatible client together with ``api_base``.

Used by both the chat endpoint (chat model) and the research runner (research
model) so the two never drift apart.
"""

from __future__ import annotations

from api.schemas.settings import ProviderConfig


def retag_model_for_litellm(
    provider: ProviderConfig | None,
    model: str,
    api_key: str | None,
) -> tuple[str, str | None]:
    """Return ``(lite_model, api_key)`` adjusted for LiteLLM routing.

    ``split('/', 1)[1]`` preserves the raw model id even when it itself contains
    slashes (e.g. HF-style org/name). Local OpenAI-compatible servers usually
    accept any key, but LiteLLM's openai client requires one to be present —
    supply a harmless placeholder when none is configured.
    """
    lite_model = model
    needs_openai_prefix = provider is not None and (
        provider.custom
        or provider.id in {"opencode", "yandex"}
        or (provider.id == "gemini" and bool(provider.api_base))
    )
    if needs_openai_prefix and "/" in model:
        lite_model = f"openai/{model.split('/', 1)[1]}"
        if not api_key:
            api_key = "sk-noop"
    return lite_model, api_key
