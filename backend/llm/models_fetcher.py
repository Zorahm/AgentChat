"""Fetch model lists from each configured provider's /models endpoint.

Strategy:
  - OpenAI-compatible providers: GET {api_base}/models with Bearer auth
  - Anthropic:                   GET {api_base}/v1/models with x-api-key
  - Gemini:                      GET generativelanguage.googleapis.com/v1beta/models?key=...
  - Ollama:                      GET {api_base}/api/tags

Results are cached in-memory with a TTL; ``refresh=True`` bypasses cache.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from api.schemas.settings import ModelConfig, ProviderConfig


# Substrings that suggest a model is a "thinking" / reasoning model.
_THINKING_PATTERNS: tuple[str, ...] = (
    "reason", "thinking", "thought",
    "o1", "o3", "o4",
    "-r1", "deepseek-r1", "deepseek-reasoner",
    "qwq", "qwen3",
)


def looks_thinking(model_id: str) -> bool:
    s = model_id.lower()
    return any(p in s for p in _THINKING_PATTERNS)


@dataclass
class ProviderResult:
    provider_id: str
    status: str  # "ok" | "error" | "skipped"
    models: list[ModelConfig] = field(default_factory=list)
    error: str | None = None
    fetched_at: float = 0.0


class ModelsFetcher:
    """Async fetcher with per-provider TTL cache."""

    def __init__(self, ttl_seconds: float = 300.0) -> None:
        self._ttl = ttl_seconds
        self._cache: dict[str, ProviderResult] = {}
        self._lock = asyncio.Lock()

    async def fetch_all(
        self,
        providers: list[ProviderConfig],
        *,
        refresh: bool = False,
    ) -> list[ProviderResult]:
        async with self._lock:
            stale: list[ProviderConfig] = []
            for p in providers:
                if not p.enabled:
                    self._cache[p.id] = ProviderResult(
                        provider_id=p.id, status="skipped", error="provider disabled"
                    )
                    continue
                cached = self._cache.get(p.id)
                if (
                    not refresh
                    and cached is not None
                    and cached.status == "ok"
                    and time.time() - cached.fetched_at < self._ttl
                ):
                    continue
                stale.append(p)

            if stale:
                results = await asyncio.gather(
                    *(self._fetch_one(p) for p in stale), return_exceptions=False
                )
                for r in results:
                    self._cache[r.provider_id] = r

        return [self._cache.get(p.id, ProviderResult(provider_id=p.id, status="skipped"))
                for p in providers]

    def get_cached_model(self, model_id: str) -> ModelConfig | None:
        for result in self._cache.values():
            for m in result.models:
                if m.id == model_id:
                    return m
        return None

    async def _fetch_one(self, p: ProviderConfig) -> ProviderResult:
        result = ProviderResult(provider_id=p.id, status="ok", fetched_at=time.time())
        try:
            models = await _fetch_provider_model_ids(p)
        except Exception as exc:
            result.status = "error"
            result.error = _short_err(exc)
            return result

        result.models = [
            ModelConfig(
                id=f"{p.id}/{mid}",
                name=_format_model_name(mname),
                thinking=True if looks_thinking(mid) else None,
            )
            for mid, mname in models
        ]
        return result


def _short_err(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.HTTPError):
        return f"{type(exc).__name__}: {exc}"
    return str(exc) or type(exc).__name__


def _format_model_name(raw: str) -> str:
    """Convert a raw model ID (e.g. ``deepseek-v4-flash``) into a readable name."""
    name = raw
    name = re.sub(r"[- ]?\(?[Ll]ab\)?$", "", name)
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    # Already readable (has spaces, mixed case) — keep as-is
    if " " in name and not name.islower() and not name.isupper():
        return name
    name = name.replace("-", " ").replace("_", " ")
    KNOWN_CAPS: dict[str, str] = {
        "gpt": "GPT", "gpt4": "GPT4",
        "deepseek": "DeepSeek", "claude": "Claude",
        "qwen": "Qwen", "kimi": "Kimi", "mimo": "MiMo",
        "minimax": "MiniMax", "gemini": "Gemini",
        "openai": "OpenAI", "anthropic": "Anthropic",
        "glm": "GLM",
    }
    parts: list[str] = []
    for word in name.split():
        lower = word.lower()
        if lower in KNOWN_CAPS:
            parts.append(KNOWN_CAPS[lower])
        elif word.isupper() and len(word) <= 2:
            parts.append(word)
        elif word.lower() in {"v", "vs", "x", "xl", "xxl"}:
            parts.append(word.upper())
        else:
            parts.append(word[0].upper() + word[1:] if word else word)
    return " ".join(parts)


async def _fetch_provider_model_ids(p: ProviderConfig) -> list[tuple[str, str]]:
    """Return list of (model_id, display_name) tuples."""
    if not p.api_base:
        raise ValueError("api_base not configured")
    if not p.api_key and p.id not in {"ollama", "lmstudio", "litellm_proxy"}:
        # local providers don't require a real key
        raise ValueError("api_key not set")

    base = p.api_base.rstrip("/")

    if p.id == "anthropic":
        url = f"{base}/v1/models"
        headers = {
            "x-api-key": p.api_key or "",
            "anthropic-version": "2023-06-01",
        }
    elif p.id == "gemini":
        key = p.api_key or ""
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
        headers: dict[str, str] = {}
    elif p.id == "ollama":
        url = f"{base}/api/tags"
        headers = {}
    else:
        url = f"{base}/models"
        headers = {"Authorization": f"Bearer {p.api_key}"} if p.api_key else {}

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data: Any = resp.json()

    return _extract_model_ids(p.id, data)


def _extract_model_ids(provider_id: str, data: Any) -> list[tuple[str, str]]:
    """Return list of (model_id, display_name) tuples from provider response."""
    if provider_id == "gemini":
        entries = data.get("models", []) if isinstance(data, dict) else []
        out: list[tuple[str, str]] = []
        for m in entries:
            name = m.get("name", "")
            if name.startswith("models/"):
                name = name[len("models/"):]
            if name:
                out.append((name, m.get("displayName", name)))
        return out

    if provider_id == "ollama":
        entries = data.get("models", []) if isinstance(data, dict) else []
        return [(m["name"], m["name"]) for m in entries if isinstance(m, dict) and m.get("name")]

    # OpenAI-compatible: {"data": [{"id": "...", "name": "..."}, ...]}
    # or {"models": [{"id": "..."}, ...]}
    if isinstance(data, dict):
        if isinstance(data.get("data"), list):
            return [
                (m["id"], m.get("name") or m["id"])
                for m in data["data"]
                if isinstance(m, dict) and m.get("id")
            ]
        if isinstance(data.get("models"), list):
            return [
                (m["id"], m.get("name") or m["id"])
                for m in data["models"]
                if isinstance(m, dict) and m.get("id")
            ]
    if isinstance(data, list):
        return [
            (m["id"], m.get("name") or m["id"])
            for m in data if isinstance(m, dict) and m.get("id")
        ]
    return []
