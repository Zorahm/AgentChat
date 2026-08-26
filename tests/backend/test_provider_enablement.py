"""A provider is enabled only once it can actually answer.

Every built-in shipped ``enabled=True``, so a fresh install lit up all seven —
six of them for vendors the user has no account with. What turns a provider on
is a key, not the app's first boot.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.settings import ProviderCreate, ProviderUpdate  # noqa: E402
from store.settings_store import SettingsStore  # noqa: E402

KEY = "sk-live-1234567890abcdef"

# Every env var _resolve_env_api_key consults for a built-in. The dev machine
# running the suite may well have some of them set.
ENV_KEY_VARS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "YANDEX_API_KEY",
)


@pytest.fixture(autouse=True)
def _no_env_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ENV_KEY_VARS:
        monkeypatch.delenv(var, raising=False)


def _store(tmp_path: Path) -> SettingsStore:
    return SettingsStore(settings_path=tmp_path / "settings.json")


def _enabled(store: SettingsStore) -> set[str]:
    return {p.id for p in store.list_providers() if p.enabled}


class TestFreshInstall:
    def test_nothing_is_enabled_before_a_key_exists(self, tmp_path: Path) -> None:
        assert _enabled(_store(tmp_path)) == set()

    def test_an_env_key_enables_exactly_its_own_provider(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
        assert _enabled(_store(tmp_path)) == {"anthropic"}


class TestKeyEntry:
    def test_saving_a_key_enables_only_that_provider(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        assert _enabled(store) == {"openai"}

    def test_enablement_survives_a_reload(self, tmp_path: Path) -> None:
        _store(tmp_path).update_provider("openai", ProviderUpdate(api_key=KEY))
        assert _enabled(_store(tmp_path)) == {"openai"}

    def test_clearing_the_key_disables_it_again(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        store.update_provider("openai", ProviderUpdate(api_key=""))
        assert _enabled(store) == set()

    def test_an_explicit_off_survives_a_new_key(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        store.update_provider("openai", ProviderUpdate(enabled=False))
        store.update_provider("openai", ProviderUpdate(api_key="sk-rotated"))
        assert _enabled(store) == set()

    def test_an_explicit_off_survives_a_reload(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        store.update_provider("openai", ProviderUpdate(enabled=False))
        assert _enabled(_store(tmp_path)) == set()

    def test_a_custom_provider_is_on_the_moment_it_is_added(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_provider(
            ProviderCreate(id="lm", name="LM Studio", api_base="http://localhost:1234/v1")
        )
        assert _enabled(store) == {"lm"}


class TestLocalEndpointsNeedNoKey:
    def test_a_built_in_pointed_at_localhost_stays_enabled(self, tmp_path: Path) -> None:
        """A keyless *local* server answers fine, so a key is not the gate there."""
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps(
                {
                    "providers": [
                        {
                            "id": "openai",
                            "name": "OpenAI",
                            "api_base": "http://localhost:1234/v1",
                            "enabled": True,
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        assert _enabled(SettingsStore(settings_path=path)) == {"openai"}


class TestHealingAnOldInstall:
    """Installs made before the fix have all seven built-ins on with one key."""

    def test_load_drops_the_providers_that_were_never_configured(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps(
                {
                    "providers": [
                        {"id": pid, "name": pid, "enabled": True}
                        for pid in ("openai", "anthropic", "gemini", "deepseek")
                    ]
                }
            ),
            encoding="utf-8",
        )
        store = SettingsStore(settings_path=path)
        store.update_provider("anthropic", ProviderUpdate(api_key=KEY))
        assert _enabled(store) == {"anthropic"}
