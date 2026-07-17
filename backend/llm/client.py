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
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.api_base = api_base
        self.api_key = api_key
        self.extra_headers = extra_headers

    def _kwargs(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        extra_body: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
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
        if self.extra_headers:
            kwargs["extra_headers"] = self.extra_headers
        if extra_body:
            kwargs["extra_body"] = extra_body
        if metadata:
            # Read back in llm/usage_logging.py's CustomLogger callback to
            # attribute usage/cost to a chat + message without threading a
            # return value through every provider's response shape.
            kwargs["metadata"] = metadata
        return kwargs

    async def completion(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> litellm.ModelResponse:
        """Non-streaming completion. Returns the full ModelResponse."""
        kwargs = self._kwargs(model, messages, tools, extra_body, metadata)
        kwargs["stream"] = False
        return await litellm.acompletion(**kwargs)

    async def completion_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AsyncGenerator[Any, None]:
        """Streaming completion. Yields raw LiteLLM chunks as they arrive."""
        kwargs = self._kwargs(model, messages, tools, extra_body, metadata)
        kwargs["stream"] = True
        # Without this, usage only arrives for OpenAI-compatible providers by
        # accident; Anthropic and others ignore the extra kwarg harmlessly.
        kwargs["stream_options"] = {"include_usage": True}
        response = await litellm.acompletion(**kwargs)
        async for chunk in response:
            yield chunk
