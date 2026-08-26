"""Chat modes: the registry, the slot they share with agents, and the retirement.

A mode reuses the agent pipeline rather than adding a path of its own, so most
of what needs pinning is that it really does arrive there — and that the maths
whitelist, which is the reason the mode exists, is still enforced once it does.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.modes import MATH_MODE, NORMAL_MODE, get_mode, mode_ids
from api.agent_runtime import resolve_agent_runtime
from schemas.agents import AgentConfig
from store.agent_presets import builtin_presets, retired_preset, retired_preset_ids


class TestRegistry:
    def test_the_normal_mode_is_the_absence_of_one(self) -> None:
        assert get_mode(NORMAL_MODE) is None
        assert get_mode(None) is None

    def test_math_resolves(self) -> None:
        mode = get_mode(MATH_MODE)
        assert mode is not None
        assert mode.id == MATH_MODE

    def test_an_unknown_id_reads_as_normal_rather_than_failing(self) -> None:
        """That is what a chat saved by a newer build looks like after a
        downgrade; refusing to open it would be the worse answer."""
        assert get_mode("quantum-astrology") is None

    def test_each_call_returns_a_fresh_config(self) -> None:
        """AgentConfig is mutable, so a shared instance would let one request's
        edit leak into the next."""
        first, second = get_mode(MATH_MODE), get_mode(MATH_MODE)
        assert first is not None and second is not None
        assert first is not second
        first.name = "clobbered"
        assert get_mode(MATH_MODE).name != "clobbered"  # type: ignore[union-attr]

    def test_math_keeps_no_memory_of_its_own(self) -> None:
        """A mode is shared by every chat that switches into it; facts belong to
        an agent, which is the thing a user owns."""
        mode = get_mode(MATH_MODE)
        assert mode is not None
        assert mode.memory_enabled is False

    def test_the_ids_are_advertised_for_the_ui_contract(self) -> None:
        assert MATH_MODE in mode_ids()
        assert NORMAL_MODE not in mode_ids()


class TestModeReachesTheRuntime:
    @staticmethod
    def _runtime(mode_id: str):  # type: ignore[no-untyped-def]
        return resolve_agent_runtime(
            agent=get_mode(mode_id),
            requested_model="gpt-x",
            default_model="default-model",
            default_temperature=0.7,
            memory_store=None,
        )

    def test_the_whitelist_survives_into_the_overlays(self) -> None:
        """`permits` is what api.chat consults for web search, research, image
        generation and MCP — the tools the factory never sees."""
        runtime = self._runtime(MATH_MODE)
        assert not runtime.permits("web_search")
        assert not runtime.permits("research")
        assert not runtime.permits("image_generate")
        assert not runtime.permits("mcp__anything__at_all")
        assert runtime.permits("math_verify")

    def test_the_modes_temperature_beats_the_global_one(self) -> None:
        assert self._runtime(MATH_MODE).temperature == pytest.approx(0.1)

    def test_a_mode_does_not_pin_the_model(self) -> None:
        """The chat's own model choice still applies — the mode changes how the
        model is asked, not which one answers."""
        assert self._runtime(MATH_MODE).model == "gpt-x"

    def test_normal_mode_leaves_everything_alone(self) -> None:
        runtime = self._runtime(NORMAL_MODE)
        assert runtime.permits("web_search")
        assert runtime.temperature == pytest.approx(0.7)


class TestPresetRetirement:
    def test_nothing_ships_as_a_preset_agent_any_more(self) -> None:
        assert builtin_presets() == {}

    def test_math_is_listed_as_retired(self) -> None:
        assert "math" in retired_preset_ids()

    def test_the_retired_shape_is_frozen_not_rederived(self) -> None:
        """The two agree today, which is the trap: the mode is live and will be
        tuned, and if the comparison read from it, that tuning would make every
        untouched preset on disk look edited and strand it forever."""
        shipped = retired_preset("math")
        mode = get_mode(MATH_MODE)
        assert shipped is not None and mode is not None

        mode.temperature = 1.9  # stand in for any future tuning of the mode

        assert retired_preset("math") is not None
        assert retired_preset("math").temperature == pytest.approx(0.1)  # type: ignore[union-attr]


class TestRetirementInTheStore:
    @staticmethod
    def _store(tmp_path: Path):  # type: ignore[no-untyped-def]
        from store.settings_store import SettingsStore

        return SettingsStore(tmp_path / "settings.json")

    def test_an_untouched_copy_is_removed(self, tmp_path: Path) -> None:
        store = self._store(tmp_path)
        shipped = retired_preset("math")
        assert shipped is not None
        store._agents["math"] = shipped
        store._seeded_agents.add("math")

        store._seed_presets()

        assert store.get_agent("math") is None

    def test_an_edited_copy_is_left_alone(self, tmp_path: Path) -> None:
        """The moment the user changed it, it stopped being ours."""
        store = self._store(tmp_path)
        shipped = retired_preset("math")
        assert shipped is not None
        mine = AgentConfig(**{**shipped.model_dump(), "name": "Моя матеша"})
        store._agents["math"] = mine
        store._seeded_agents.add("math")

        store._seed_presets()

        kept = store.get_agent("math")
        assert kept is not None
        assert kept.name == "Моя матеша"

    def test_a_fresh_install_gets_no_math_agent(self, tmp_path: Path) -> None:
        assert self._store(tmp_path).get_agent("math") is None


class TestModeSurvivesPersistence:
    """The mode is chosen once and must still be there on every later turn — it
    is what the request carries and what the chip renders from, so losing it on
    reload silently drops the chat back to the normal mode."""

    @staticmethod
    def _store(tmp_path: Path):  # type: ignore[no-untyped-def]
        from store.chat_store import ChatStore

        return ChatStore(tmp_path / "chats.db")

    def test_it_round_trips_through_create_and_read(self, tmp_path: Path) -> None:
        store = self._store(tmp_path)
        store.upsert_chat(chat_id="c1", title="t", dir_slug="", mode="math")

        assert store.get_chat("c1")["mode"] == "math"
        assert store.list_chats()[0]["mode"] == "math"

    def test_it_survives_reopening_the_database(self, tmp_path: Path) -> None:
        self._store(tmp_path).upsert_chat(chat_id="c1", title="t", dir_slug="", mode="math")

        assert self._store(tmp_path).get_chat("c1")["mode"] == "math"

    def test_a_patch_that_omits_it_leaves_it_alone(self, tmp_path: Path) -> None:
        """The UI PUTs partial updates constantly (title, tree); any of them
        clearing the mode would reset the chat mid-conversation."""
        store = self._store(tmp_path)
        store.upsert_chat(chat_id="c1", title="t", dir_slug="", mode="math")

        store.update_chat("c1", title="renamed")

        assert store.get_chat("c1")["mode"] == "math"

    def test_a_chat_from_before_modes_existed_still_opens(self, tmp_path: Path) -> None:
        """Existing databases get the column by ALTER TABLE; the rows already in
        them have to read as the normal mode rather than blow up."""
        import sqlite3

        db = tmp_path / "chats.db"
        legacy = sqlite3.connect(str(db))
        legacy.executescript(
            """
            CREATE TABLE chats (
              id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
              dir_slug TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL, root_json TEXT NOT NULL DEFAULT '[]',
              mcp_enabled_json TEXT NOT NULL DEFAULT '[]',
              project_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '');
            INSERT INTO chats (id, title, created_at, updated_at)
            VALUES ('old', 'Legacy chat', 1, 1);
            """
        )
        legacy.commit()
        legacy.close()

        store = self._store(tmp_path)

        row = store.get_chat("old")
        assert row is not None
        assert row["title"] == "Legacy chat"
        assert row["mode"] == ""


class TestModeBeatsTheAgentInTheRequest:
    def test_the_mode_replaces_an_attached_agent(self, tmp_path: Path) -> None:
        """Both fill the same slot. api.chat consults get_mode first, so a chat
        carrying a stale agent_id alongside a mode answers as the mode."""
        from store.settings_store import SettingsStore

        settings = SettingsStore(tmp_path / "settings.json")
        chosen = get_mode("math") or settings.get_agent("default")

        assert chosen is not None
        assert chosen.id == "math"

    def test_without_a_mode_the_agent_still_wins(self) -> None:
        assert get_mode("") is None  # falls through to the stored agent
