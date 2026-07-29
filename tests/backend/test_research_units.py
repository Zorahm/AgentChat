"""Unit tests for the research package's pure pieces: budget, sources, report paths."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy
from research.budget import BudgetTracker, ResearchBudget
from research.delegate_tool import _parse_tasks
from research.lead_tools import _as_titles
from research.report import resolve_report_path, slugify
from research.sources import audit_citations, dedupe, extract_urls
from shell import resolve_active_shell

# The runner writes into a real tmp_path, so the policy's path namespace has to
# match this host's — a posix policy on Windows resolves to an unreachable path.
HOST_SHELL = resolve_active_shell("powershell")


class TestBudgetTracker:
    def test_grants_up_to_parallel_cap(self) -> None:
        tracker = BudgetTracker(ResearchBudget(max_parallel=2, max_subagents=8, max_rounds=3))
        assert tracker.open_round(5) == 2
        assert tracker.subagents_used == 2
        assert tracker.rounds_used == 1

    def test_partial_grant_when_few_slots_left(self) -> None:
        """Asking for more than remains runs what remains instead of failing."""
        tracker = BudgetTracker(ResearchBudget(max_parallel=4, max_subagents=3, max_rounds=3))
        assert tracker.open_round(2) == 2
        assert tracker.open_round(4) == 1
        assert tracker.open_round(1) == 0

    def test_round_cap_refuses(self) -> None:
        tracker = BudgetTracker(ResearchBudget(max_rounds=1, max_subagents=8, max_parallel=4))
        assert tracker.open_round(1) == 1
        assert tracker.refusal() is not None
        assert tracker.open_round(1) == 0

    def test_spent_time_refuses(self) -> None:
        tracker = BudgetTracker(ResearchBudget(total_seconds=0.0))
        assert tracker.refusal() is not None
        assert tracker.open_round(1) == 0

    def test_status_line_reports_spend(self) -> None:
        tracker = BudgetTracker(ResearchBudget(max_subagents=8, max_rounds=3))
        tracker.open_round(2)
        line = tracker.status_line()
        assert "2/8 subagents" in line
        assert "1/3 rounds" in line


class TestSources:
    def test_extract_strips_trailing_punctuation(self) -> None:
        text = "see http://a.com/x, and (http://b.com/y)."
        assert extract_urls(text) == ["http://a.com/x", "http://b.com/y"]

    def test_extract_dedupes_preserving_order(self) -> None:
        assert extract_urls("http://a.com http://b.com http://a.com") == [
            "http://a.com",
            "http://b.com",
        ]

    def test_dedupe_drops_blanks(self) -> None:
        assert dedupe(["", "http://a.com", "http://a.com"]) == ["http://a.com"]

    def test_audit_accepts_cosmetic_url_differences(self) -> None:
        """www., scheme and a trailing slash don't make it a different source."""
        report = "Claim [1]\n\n1. Example — https://www.example.com/page/"
        assert audit_citations(report, ["http://example.com/page"]) == []

    def test_audit_flags_url_nobody_opened(self) -> None:
        report = "Claim [1]\n\n1. Ghost — https://fabricated.example/report"
        warnings = audit_citations(report, ["https://real.example/page"])
        assert len(warnings) == 1
        assert "fabricated.example" in warnings[0]

    def test_audit_silent_without_a_known_source_set(self) -> None:
        assert audit_citations("http://a.com", []) == []


class TestArgumentParsing:
    def test_plan_accepts_strings_and_objects(self) -> None:
        assert _as_titles(["a", {"title": "b"}, {"question": "c"}]) == ["a", "b", "c"]

    def test_plan_rejects_non_list(self) -> None:
        assert _as_titles(None) == []
        assert _as_titles(42) == []

    def test_plan_accepts_a_bare_string(self) -> None:
        assert _as_titles("only one") == ["only one"]

    def test_tasks_require_a_prompt(self) -> None:
        parsed = _parse_tasks([{"title": "t", "prompt": ""}, {"title": "u", "prompt": "dig"}])
        assert [t.title for t in parsed] == ["u"]

    def test_tasks_accept_bare_prompt_strings(self) -> None:
        parsed = _parse_tasks(["find the benchmarks"])
        assert parsed[0].prompt == "find the benchmarks"
        assert parsed[0].title == "find the benchmarks"


class TestReportPath:
    def test_slugify_keeps_non_latin_letters(self) -> None:
        assert slugify("Обзор рынка 2026") == "обзор-рынка-2026"

    def test_slugify_survives_punctuation_only_titles(self) -> None:
        assert slugify("!!! ???") == ""

    @pytest.mark.asyncio
    async def test_second_run_does_not_overwrite_the_first(self, tmp_path: Path) -> None:
        policy = SandboxPolicy(chat_dir=str(tmp_path), shell=HOST_SHELL)
        first = await resolve_report_path("Test Title", policy)
        assert Path(first).name == "research-test-title.md"

        Path(first).write_text("first report", encoding="utf-8")
        second = await resolve_report_path("Test Title", policy)

        assert Path(second).name == "research-test-title-2.md"
        assert Path(first).read_text(encoding="utf-8") == "first report"

    @pytest.mark.asyncio
    async def test_untitled_report_still_gets_a_path(self, tmp_path: Path) -> None:
        policy = SandboxPolicy(chat_dir=str(tmp_path), shell=HOST_SHELL)
        path = await resolve_report_path("???", policy)
        assert Path(path).name == "research-report.md"
