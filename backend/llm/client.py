"""Async LiteLLM client wrapper for completion calls."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import litellm


class LLMClient:
    """Thin async wrapper around LiteLLM for agent loop usage."""

    def __init__(
        self,
        api_base: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.api_base = api_base
        self.api_key = api_key

    def _kwargs(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        extra_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools
        if self.api_base:
            kwargs["api_base"] = self.api_base
        if self.api_key:
            kwargs["api_key"] = self.api_key
        if extra_body:
            kwargs["extra_body"] = extra_body
        return kwargs

    async def completion(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> litellm.ModelResponse:
        """Non-streaming completion. Returns the full ModelResponse."""
        kwargs = self._kwargs(model, messages, tools, extra_body)
        kwargs["stream"] = False
        return await litellm.acompletion(**kwargs)

    async def completion_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> AsyncGenerator[Any, None]:
        """Streaming completion. Yields raw LiteLLM chunks as they arrive."""
        kwargs = self._kwargs(model, messages, tools, extra_body)
        kwargs["stream"] = True
        response = await litellm.acompletion(**kwargs)
        async for chunk in response:
            yield chunk
