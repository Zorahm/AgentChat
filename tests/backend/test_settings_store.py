"""Tests for SettingsStore persistence of the research settings."""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.settings import SettingsUpdate
from store.settings_store import SettingsStore


class TestResearchSettings:
    def test_defaults(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        data = store.get()
        assert data.research_enabled is False
        assert data.research_lead_model == ""
        assert data.research_worker_model == ""

    def test_update_returns_values(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        data = store.update(
            SettingsUpdate(
                research_enabled=True,
                research_lead_model="anthropic/lead",
                research_worker_model="anthropic/worker",
            )
        )
        assert data.research_enabled is True
        assert data.research_lead_model == "anthropic/lead"
        assert data.research_worker_model == "anthropic/worker"
        assert store.research_enabled is True
        assert store.research_lead_model == "anthropic/lead"
        assert store.research_worker_model == "anthropic/worker"

    def test_unset_worker_model_follows_the_lead(self, tmp_path: Path) -> None:
        """Subagents run on the lead's model until the user picks a cheaper one."""
        store = SettingsStore(settings_path=tmp_path / "s.json")
        store.update(SettingsUpdate(research_lead_model="anthropic/lead"))
        assert store.research_worker_model == "anthropic/lead"
        # The stored value stays empty so the UI can show "same as lead".
        assert store.get().research_worker_model == ""

    def test_round_trip_persists_across_reload(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        SettingsStore(settings_path=path).update(
            SettingsUpdate(
                research_enabled=True,
                research_lead_model="openai/gpt-4o",
                research_worker_model="openai/gpt-4o-mini",
            )
        )
        reloaded = SettingsStore(settings_path=path).get()
        assert reloaded.research_enabled is True
        assert reloaded.research_lead_model == "openai/gpt-4o"
        assert reloaded.research_worker_model == "openai/gpt-4o-mini"

    def test_pre_split_research_model_seeds_the_lead(self, tmp_path: Path) -> None:
        """An install upgraded from the single-model setting keeps its model."""
        path = tmp_path / "s.json"
        path.write_text(
            json.dumps({"global": {"research_enabled": True, "research_model": "openai/legacy"}}),
            encoding="utf-8",
        )
        data = SettingsStore(settings_path=path).get()
        assert data.research_lead_model == "openai/legacy"
        assert data.research_worker_model == ""
