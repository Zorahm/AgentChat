"""Tests for SettingsStore persistence of the research settings."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.schemas.settings import SettingsUpdate
from store.settings_store import SettingsStore


class TestResearchSettings:
    def test_defaults(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        data = store.get()
        assert data.research_enabled is False
        assert data.research_model == ""

    def test_update_returns_values(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        data = store.update(SettingsUpdate(research_enabled=True, research_model="anthropic/x"))
        assert data.research_enabled is True
        assert data.research_model == "anthropic/x"
        assert store.research_enabled is True
        assert store.research_model == "anthropic/x"

    def test_round_trip_persists_across_reload(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        SettingsStore(settings_path=path).update(
            SettingsUpdate(research_enabled=True, research_model="openai/gpt-4o")
        )
        reloaded = SettingsStore(settings_path=path).get()
        assert reloaded.research_enabled is True
        assert reloaded.research_model == "openai/gpt-4o"
