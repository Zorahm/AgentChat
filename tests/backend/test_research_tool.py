"""Tests for the research tool + runner."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import agent.research_runner as rr
from agent.sandbox import SandboxPolicy
from mcp_integration.registry_view import MCPAwareRegistry
from store.settings_store import SettingsStore
from tools.registry import ToolRegistry
from tools.research_tool import ResearchTool
from web_search.config import SearchResult
from web_search.service import ResolvedWebSearch


# ── scripted LLM that can emit a tool call then a final report ───────────────

def _content_chunk(text: str) -> SimpleNamespace:
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _toolcall_chunk(call_id: str, name: str, arguments: str) -> SimpleNamespace:
    tc = SimpleNamespace(index=0, id=call_id, function=SimpleNamespace(name=name, arguments=arguments))
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class _ScriptedLLM:
    """Replays a list of turns (each a list of LiteLLM-shaped chunks)."""

    def __init__(self, turns: list[list[SimpleNamespace]]) -> None:
        self._turns = turns
        self.call_count = 0

    async def completion_stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> Any:
        turn = self._turns[self.call_count]
        self.call_count += 1
        for ch in turn:
            yield ch


class _FakeService:
    """Web search service stand-in with a forced backend + canned results."""

    def __init__(self, effective: str = "litellm") -> None:
        self._effective = effective

    def resolve(self, provider_id: str, model: str, mode: str, config: Any) -> ResolvedWebSearch:
        return ResolvedWebSearch(effective=self._effective)  # type: ignore[arg-type]

    async def search(self, query: str, config: Any, backend: str, max_results: int = 5) -> list[SearchResult]:
        return [SearchResult(title="Example", url="http://example.com", snippet="snip")]


def _policy(chat_dir: Path) -> SandboxPolicy:
    return SandboxPolicy(chat_dir=str(chat_dir), shell="powershell")


def _tool(service: _FakeService, store: SettingsStore, chat_dir: Path) -> ResearchTool:
    tool = ResearchTool(
        store=store,
        web_search_service=service,  # type: ignore[arg-type]
        provider_id="anthropic",
        model="anthropic/claude",
        lite_model="anthropic/claude",
        api_key=None,
        api_base=None,
        extra_headers=None,
    )
    tool.set_policy(_policy(chat_dir))
    return tool


@pytest.fixture
def store(tmp_path: Path) -> SettingsStore:
    return SettingsStore(settings_path=tmp_path / "settings.json")


class TestResearchTool:
    @pytest.mark.asyncio
    async def test_happy_path_writes_report_and_instructs_present(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        report = "# Title\n\n## Summary\nAnswer [1]\n\n## Sources\n1. Example — http://example.com"
        scripted = _ScriptedLLM(turns=[
            [_toolcall_chunk("c1", "web_search", '{"query": "topic facts"}')],
            [_content_chunk(report)],
        ])
        monkeypatch.setattr(rr, "LLMClient", lambda **_: scripted)

        out = await _tool(_FakeService("litellm"), store, tmp_path).execute(topic="a topic")

        assert out.startswith("Research complete")
        # The model is told to present the EXACT absolute path (relative would
        # 404 in the UI's /files/content fetch).
        assert "present_files(paths=['" in out
        saved = tmp_path / "report.md"
        assert str(saved) in out
        assert saved.exists()
        assert saved.read_text(encoding="utf-8") == report

    @pytest.mark.asyncio
    async def test_no_web_backend_fails_gracefully(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # resolve() returns "none" — the runner must bail BEFORE any LLM call,
        # so a missing LLMClient patch proves it never tried to run a loop.
        def _boom(**_: Any) -> Any:
            raise AssertionError("LLMClient should not be constructed when no backend")

        monkeypatch.setattr(rr, "LLMClient", _boom)

        out = await _tool(_FakeService("none"), store, tmp_path).execute(topic="a topic")

        assert "no search backend" in out.lower()
        assert not (tmp_path / "report.md").exists()

    @pytest.mark.asyncio
    async def test_empty_topic_errors(self, tmp_path: Path, store: SettingsStore) -> None:
        out = await _tool(_FakeService(), store, tmp_path).execute(topic="   ")
        assert out.startswith("Error")
        assert not (tmp_path / "report.md").exists()


class TestResearchRegistryGating:
    """The loop's streams_progress hook resolves the tool via registry.get; an
    overlay registry must expose `research` only when the tool was added."""

    def test_overlay_exposes_research_when_present(self, store: SettingsStore, tmp_path: Path) -> None:
        base = ToolRegistry()
        tool = _tool(_FakeService(), store, tmp_path)
        wrapped = MCPAwareRegistry(base, [tool])
        assert "research" in wrapped.list_names()
        got = wrapped.get("research")
        assert got is tool
        assert getattr(got, "streams_progress", False) is True

    def test_base_registry_has_no_research(self) -> None:
        assert ToolRegistry().get("research") is None
