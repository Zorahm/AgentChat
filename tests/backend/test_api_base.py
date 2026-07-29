"""Tests for the local-endpoint heuristic behind the "no key needed" rule."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.settings import ProviderCreate, ProviderUpdate  # noqa: E402
from llm.api_base import is_local_base, requires_api_key  # noqa: E402
from store.settings_store import SettingsStore, to_public  # noqa: E402


LOCAL_BASES = [
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
    "http://192.168.1.16:11434/v1",
    "http://10.0.0.5:8000",
    "http://172.16.4.4:8000/v1",
    "http://host.docker.internal:1234/v1",
    "http://nas.local:9000/v1",
    # No scheme — users paste bare host:port too.
    "192.168.0.2:11434",
]

REMOTE_BASES = [
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
    "https://openrouter.ai/api/v1",
    # 8.8.8.8 is public; the private-range check must not swallow it.
    "http://8.8.8.8:8080/v1",
]


class TestIsLocalBase:
    @pytest.mark.parametrize("base", LOCAL_BASES)
    def test_local(self, base: str) -> None:
        assert is_local_base(base) is True

    @pytest.mark.parametrize("base", REMOTE_BASES)
    def test_remote(self, base: str) -> None:
        assert is_local_base(base) is False

    def test_missing_base_is_not_local(self) -> None:
        assert is_local_base(None) is False
        assert is_local_base("") is False


class TestRequiresApiKey:
    def test_remote_provider_needs_a_key(self) -> None:
        assert requires_api_key("openai", "https://api.openai.com/v1") is True

    def test_local_provider_does_not(self) -> None:
        assert requires_api_key("my_llm", "http://localhost:1234/v1") is False

    def test_legacy_local_ids_never_need_one(self) -> None:
        """Older settings.json files predate the URL heuristic."""
        assert requires_api_key("lmstudio", "https://elsewhere.example/v1") is False


class TestProviderPublicHints:
    def test_builtin_carries_its_default_base(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        openai = next(p for p in store.get().providers if p.id == "openai")
        assert openai.default_api_base == "https://api.openai.com/v1"
        assert openai.key_required is True

    def test_custom_local_provider_needs_no_key(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        store.add_provider(
            ProviderCreate(id="local", name="Local", api_base="http://192.168.1.16:11434/v1")
        )
        local = next(p for p in store.get().providers if p.id == "local")
        assert local.key_required is False
        # Nothing to reset to — it was never shipped with a URL.
        assert local.default_api_base is None

    def test_editing_a_builtin_base_flips_the_key_requirement(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "s.json")
        updated = store.update_provider(
            "openai", ProviderUpdate(api_base="  http://localhost:1234/v1  ")
        )
        # Whitespace from a paste must not leak into the stored URL.
        assert updated.api_base == "http://localhost:1234/v1"
        public = to_public(updated)
        assert public.key_required is False
        assert public.default_api_base == "https://api.openai.com/v1"
