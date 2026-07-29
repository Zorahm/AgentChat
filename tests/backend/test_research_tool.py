"""End-to-end tests for the research tool: brief in, cited report file out."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import research.lead as lead_mod
import research.worker as worker_mod
from agent.sandbox import SandboxPolicy
from mcp_integration.registry_view import MCPAwareRegistry
from research.types import ModelEndpoint
from shell import resolve_active_shell
from store.settings_store import SettingsStore
from tools.registry import ToolRegistry
from tools.research_tool import ResearchTool
from web_search.config import SearchResult
from web_search.service import ResolvedWebSearch

# The run writes its report into a real ``tmp_path``, so the policy's path
# namespace has to match the host's.
HOST_SHELL = resolve_active_shell("powershell")

REPORT_MD = "# Test Title\n\nThe answer [1].\n\n## Sources\n1. Example — http://example.com"


# ── scripted LLM ─────────────────────────────────────────────────────────────

def _content_chunk(text: str) -> SimpleNamespace:
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _toolcall_chunk(call_id: str, name: str, arguments: str) -> SimpleNamespace:
    tc = SimpleNamespace(
        index=0, id=call_id, function=SimpleNamespace(name=name, arguments=arguments)
    )
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


class _ScriptedLLM:
    """Replays a list of turns. The lead and every subagent draw from this one
    script in call order, which is what makes a nested run deterministic."""

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
        metadata: dict[str, Any] | None = None,
    ) -> Any:
        turn = self._turns[self.call_count]
        self.call_count += 1
        for chunk in turn:
            yield chunk


class _FakeService:
    """Web-search service stand-in with a forced backend and canned results."""

    def __init__(self, effective: str = "litellm") -> None:
        self._effective = effective

    def resolve(self, provider_id: str, model: str, mode: str, config: Any) -> ResolvedWebSearch:
        return ResolvedWebSearch(effective=self._effective)  # type: ignore[arg-type]

    async def search(
        self, query: str, config: Any, backend: str, max_results: int = 5
    ) -> list[SearchResult]:
        return [SearchResult(title="Example", url="http://example.com", snippet="snip")]


def _endpoint() -> ModelEndpoint:
    return ModelEndpoint(provider_id="anthropic", model="anthropic/c", lite_model="anthropic/c")


def _tool(service: _FakeService, store: SettingsStore, chat_dir: Path) -> ResearchTool:
    tool = ResearchTool(
        store=store,
        web_search_service=service,  # type: ignore[arg-type]
        lead=_endpoint(),
        worker=_endpoint(),
    )
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell=HOST_SHELL))
    return tool


def _install(monkeypatch: pytest.MonkeyPatch, scripted: _ScriptedLLM) -> None:
    """Point both the lead's and the subagents' LLM clients at the script."""
    monkeypatch.setattr(lead_mod, "LLMClient", lambda **_: scripted)
    monkeypatch.setattr(worker_mod, "LLMClient", lambda **_: scripted)


def _drain(queue: "asyncio.Queue[dict[str, Any]]") -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


@pytest.fixture
def store(tmp_path: Path) -> SettingsStore:
    return SettingsStore(settings_path=tmp_path / "settings.json")


# ── the full loop ────────────────────────────────────────────────────────────

def _full_run_script() -> _ScriptedLLM:
    """lead plans → lead delegates → subagent reports → lead submits."""
    return _ScriptedLLM(
        turns=[
            [_toolcall_chunk("c1", "plan_research", '{"steps": ["angle one", "angle two"]}')],
            [
                _toolcall_chunk(
                    "c2",
                    "run_subagents",
                    '{"tasks": [{"title": "Angle one", "prompt": "dig into angle one"}]}',
                )
            ],
            [
                _toolcall_chunk(
                    "c3",
                    "submit_findings",
                    '{"summary": "angle one holds", "sources": ["http://example.com"]}',
                )
            ],
            [
                _toolcall_chunk(
                    "c4",
                    "submit_report",
                    '{"title": "Test Title", "markdown": '
                    '"# Test Title\\n\\nThe answer [1].\\n\\n## Sources\\n1. Example — http://example.com"}',
                )
            ],
        ]
    )


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_writes_a_titled_report_and_instructs_present_files(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install(monkeypatch, _full_run_script())

        out = await _tool(_FakeService(), store, tmp_path).execute(brief="Investigate the thing")

        assert out.startswith("Research complete")
        # The model must present the EXACT absolute path — a relative one 404s in
        # the UI's /files/content fetch.
        assert "present_files(paths=['" in out
        saved = tmp_path / "research-test-title.md"
        assert str(saved) in out
        assert saved.read_text(encoding="utf-8") == REPORT_MD

    @pytest.mark.asyncio
    async def test_progress_describes_the_plan_and_the_subagent(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install(monkeypatch, _full_run_script())
        tool = _tool(_FakeService(), store, tmp_path)

        await tool.execute(brief="Investigate the thing")
        events = _drain(tool.progress_queue)
        kinds = [e["kind"] for e in events]

        plan = next(e for e in events if e["kind"] == "plan")
        assert [s["title"] for s in plan["steps"]] == ["angle one", "angle two"]
        assert "agent_start" in kinds and "agent_end" in kinds
        assert any(e["kind"] == "agent_start" and e["agentId"] == "a1" for e in events)
        done = next(e for e in events if e["kind"] == "done")
        assert done["title"] == "Test Title"
        assert done["path"].endswith("research-test-title.md")

    @pytest.mark.asyncio
    async def test_a_second_run_keeps_the_first_report(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install(monkeypatch, _full_run_script())
        await _tool(_FakeService(), store, tmp_path).execute(brief="first")
        _install(monkeypatch, _full_run_script())
        await _tool(_FakeService(), store, tmp_path).execute(brief="second")

        assert (tmp_path / "research-test-title.md").exists()
        assert (tmp_path / "research-test-title-2.md").exists()


class TestDegradedRuns:
    @pytest.mark.asyncio
    async def test_lead_that_never_submits_is_asked_to_write_up(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Budget ran out mid-investigation: the salvage pass still produces a file."""
        _install(
            monkeypatch,
            _ScriptedLLM(
                turns=[
                    [_content_chunk("I am still thinking about this.")],
                    [
                        _toolcall_chunk(
                            "c9",
                            "submit_report",
                            '{"title": "Partial", "markdown": "# Partial\\n\\nWhat I have."}',
                        )
                    ],
                ]
            ),
        )

        out = await _tool(_FakeService(), store, tmp_path).execute(brief="a brief")

        assert out.startswith("Research complete")
        assert (tmp_path / "research-partial.md").exists()

    @pytest.mark.asyncio
    async def test_no_report_at_all_reports_failure_without_writing(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install(
            monkeypatch,
            _ScriptedLLM(turns=[[_content_chunk("thinking")], [_content_chunk("still thinking")]]),
        )

        out = await _tool(_FakeService(), store, tmp_path).execute(brief="a brief")

        assert "never submitted a report" in out
        assert list(tmp_path.glob("research-*.md")) == []

    @pytest.mark.asyncio
    async def test_fabricated_citation_is_reported_not_silently_fixed(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install(
            monkeypatch,
            _ScriptedLLM(
                turns=[
                    [
                        _toolcall_chunk(
                            "c1",
                            "submit_report",
                            '{"title": "Ghost", "markdown": "# Ghost\\n\\nClaim [1].\\n\\n'
                            '1. Ghost — https://invented.example/page"}',
                        )
                    ]
                ]
            ),
        )
        tool = _tool(_FakeService(), store, tmp_path)

        # A source the run really saw, so the audit has something to compare against.
        out = await tool.execute(brief="a brief")

        saved = tmp_path / "research-ghost.md"
        assert saved.exists()
        assert "invented.example" in saved.read_text(encoding="utf-8")
        # No agent opened anything this run, so there is no known-source set and
        # the audit stays silent rather than crying wolf.
        assert "Warnings" not in out

    @pytest.mark.asyncio
    async def test_no_web_backend_fails_before_any_llm_call(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _boom(**_: Any) -> Any:
            raise AssertionError("no LLM client should be built without a web backend")

        monkeypatch.setattr(lead_mod, "LLMClient", _boom)
        monkeypatch.setattr(worker_mod, "LLMClient", _boom)

        out = await _tool(_FakeService("none"), store, tmp_path).execute(brief="a brief")

        assert "no search backend" in out.lower()
        assert list(tmp_path.glob("*.md")) == []

    @pytest.mark.asyncio
    async def test_empty_brief_errors(self, tmp_path: Path, store: SettingsStore) -> None:
        out = await _tool(_FakeService(), store, tmp_path).execute(brief="   ")
        assert out.startswith("Error")

    @pytest.mark.asyncio
    async def test_legacy_topic_argument_still_reaches_the_run(
        self, tmp_path: Path, store: SettingsStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Models that learned the old single-topic shape must not lose the call."""
        _install(monkeypatch, _full_run_script())
        out = await _tool(_FakeService(), store, tmp_path).execute(topic="Investigate the thing")
        assert out.startswith("Research complete")


class TestRegistryGating:
    """agent.loop resolves the streaming tool via registry.get — the overlay must
    expose `research` only when the toggle actually added it."""

    def test_overlay_exposes_research_when_present(
        self, store: SettingsStore, tmp_path: Path
    ) -> None:
        tool = _tool(_FakeService(), store, tmp_path)
        wrapped = MCPAwareRegistry(ToolRegistry(), [tool])
        assert "research" in wrapped.list_names()
        assert wrapped.get("research") is tool
        assert getattr(wrapped.get("research"), "streams_progress", False) is True

    def test_base_registry_has_no_research(self) -> None:
        assert ToolRegistry().get("research") is None
