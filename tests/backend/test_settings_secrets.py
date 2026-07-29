"""Tests for the secret boundary around settings.json.

Two invariants, both of which used to be violated:
  1. no API key is ever written into settings.json;
  2. no API key is ever returned from the settings API.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.redaction import MASK  # noqa: E402
from schemas.settings import ProviderCreate, ProviderUpdate, SettingsUpdate  # noqa: E402
from schemas.mcp import MCPHttpConfig, MCPServerConfig, MCPServerUpdate  # noqa: E402
from store.secret_store import SecretStore  # noqa: E402
from store.settings_store import SettingsStore  # noqa: E402

KEY = "sk-live-1234567890abcdef"


def _store(tmp_path: Path) -> SettingsStore:
    return SettingsStore(settings_path=tmp_path / "settings.json")


def _raw(tmp_path: Path) -> str:
    return (tmp_path / "settings.json").read_text("utf-8")


class TestKeysLeaveTheJsonFile:
    def test_provider_key_is_not_in_settings_json(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        assert KEY not in _raw(tmp_path)

    def test_provider_key_is_in_the_secret_store(self, tmp_path: Path) -> None:
        _store(tmp_path).update_provider("openai", ProviderUpdate(api_key=KEY))
        blob = SecretStore(tmp_path / "secrets.json").get("provider:openai")
        assert blob is not None
        assert json.loads(blob)["api_key"] == KEY

    def test_tavily_and_remote_token_leave_the_file(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update(SettingsUpdate(tavily_api_key="tvly-secret", remote_access_enabled=True))
        raw = _raw(tmp_path)
        assert "tvly-secret" not in raw
        assert store.remote_token and store.remote_token not in raw

    def test_mcp_credentials_leave_the_file(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_mcp_server(
            MCPServerConfig(
                id="ctx",
                name="Ctx",
                config=MCPHttpConfig(url="https://x", headers={"Authorization": "Bearer t0k"}),
            )
        )
        assert "t0k" not in _raw(tmp_path)

    def test_key_survives_a_reload(self, tmp_path: Path) -> None:
        _store(tmp_path).update_provider("openai", ProviderUpdate(api_key=KEY))
        reloaded = _store(tmp_path)
        provider = next(p for p in reloaded.list_providers() if p.id == "openai")
        assert provider.api_key == KEY

    def test_removing_a_provider_drops_its_secret(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_provider(ProviderCreate(id="lm", name="LM", api_base="http://x", api_key=KEY))
        store.remove_provider("lm")
        assert SecretStore(tmp_path / "secrets.json").get("provider:lm") is None

    def test_removing_an_mcp_server_drops_its_secret(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_mcp_server(
            MCPServerConfig(
                id="ctx",
                name="Ctx",
                config=MCPHttpConfig(url="https://x", headers={"Authorization": "t0k"}),
            )
        )
        store.remove_mcp_server("ctx")
        assert SecretStore(tmp_path / "secrets.json").get("mcp:ctx") is None

    def test_clearing_a_key_clears_the_secret(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        store.update_provider("openai", ProviderUpdate(api_key=""))
        assert SecretStore(tmp_path / "secrets.json").get("provider:openai") is None


class TestMigrationFromInlineSecrets:
    """A settings.json written by an older build still has keys inline."""

    def _legacy_file(self, tmp_path: Path) -> Path:
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps(
                {
                    "global": {"tavily_api_key": "tvly-old", "remote_token": "tok-old"},
                    "providers": [
                        {"id": "openai", "name": "OpenAI", "api_key": KEY, "api_key_set": True}
                    ],
                    "mcp": {
                        "servers": [
                            {
                                "id": "ctx",
                                "name": "Ctx",
                                "enabled": True,
                                "config": {
                                    "transport": "http",
                                    "url": "https://x",
                                    "headers": {"Authorization": "t0k"},
                                },
                            }
                        ]
                    },
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_load_moves_secrets_out_and_keeps_them_working(self, tmp_path: Path) -> None:
        self._legacy_file(tmp_path)
        store = _store(tmp_path)

        raw = _raw(tmp_path)
        assert KEY not in raw
        assert "tvly-old" not in raw
        assert "tok-old" not in raw
        assert "t0k" not in raw

        provider = next(p for p in store.list_providers() if p.id == "openai")
        assert provider.api_key == KEY
        assert store.tavily_api_key == "tvly-old"
        assert store.remote_token == "tok-old"
        server = store.get_mcp_server("ctx")
        assert server is not None
        assert server.config.model_dump()["headers"] == {"Authorization": "t0k"}

    def test_migration_is_idempotent(self, tmp_path: Path) -> None:
        self._legacy_file(tmp_path)
        _store(tmp_path)
        first = _raw(tmp_path)
        _store(tmp_path)
        assert _raw(tmp_path) == first

    def test_stored_secret_beats_a_stale_inline_one(self, tmp_path: Path) -> None:
        path = self._legacy_file(tmp_path)
        SecretStore(tmp_path / "secrets.json").set(
            "provider:openai", json.dumps({"api_key": "sk-newer"})
        )
        store = SettingsStore(settings_path=path)
        provider = next(p for p in store.list_providers() if p.id == "openai")
        assert provider.api_key == "sk-newer"


class TestApiViewCarriesNoSecrets:
    def test_settings_payload_has_no_provider_key(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        assert KEY not in store.get().model_dump_json()

    def test_key_set_flag_reflects_reality(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.update_provider("openai", ProviderUpdate(api_key=KEY))
        public = next(p for p in store.get().providers if p.id == "openai")
        assert public.api_key_set is True
        assert not hasattr(public, "api_key")

    def test_provider_headers_are_masked(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_provider(
            ProviderCreate(
                id="lm",
                name="LM",
                api_base="http://x",
                extra_headers={"X-Auth": "header-secret"},
            )
        )
        public = next(p for p in store.get().providers if p.id == "lm")
        assert public.extra_headers == {"X-Auth": MASK}
        assert "header-secret" not in store.get().model_dump_json()

    def test_mcp_headers_are_masked(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_mcp_server(
            MCPServerConfig(
                id="ctx",
                name="Ctx",
                config=MCPHttpConfig(url="https://x", headers={"Authorization": "t0k"}),
            )
        )
        payload = store.get().model_dump_json()
        assert "t0k" not in payload
        assert MASK in payload


class TestMaskedWritesKeepStoredValues:
    def test_provider_headers_round_trip_through_the_mask(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_provider(
            ProviderCreate(
                id="lm", name="LM", api_base="http://x", extra_headers={"X-Auth": "real"}
            )
        )
        # What the UI hands back after loading a masked value and not editing it.
        store.update_provider("lm", ProviderUpdate(extra_headers={"X-Auth": MASK}))
        provider = next(p for p in store.list_providers() if p.id == "lm")
        assert provider.extra_headers == {"X-Auth": "real"}

    def test_editing_a_masked_header_replaces_it(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_provider(
            ProviderCreate(
                id="lm", name="LM", api_base="http://x", extra_headers={"X-Auth": "real"}
            )
        )
        store.update_provider("lm", ProviderUpdate(extra_headers={"X-Auth": "typed-new"}))
        provider = next(p for p in store.list_providers() if p.id == "lm")
        assert provider.extra_headers == {"X-Auth": "typed-new"}

    def test_mcp_headers_round_trip_through_the_mask(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_mcp_server(
            MCPServerConfig(
                id="ctx",
                name="Ctx",
                config=MCPHttpConfig(url="https://x", headers={"Authorization": "t0k"}),
            )
        )
        store.update_mcp_server(
            "ctx",
            MCPServerUpdate(
                config=MCPHttpConfig(url="https://x", headers={"Authorization": MASK})
            ),
        )
        server = store.get_mcp_server("ctx")
        assert server is not None
        assert server.config.model_dump()["headers"] == {"Authorization": "t0k"}

    def test_dropping_a_header_row_removes_it(self, tmp_path: Path) -> None:
        store = _store(tmp_path)
        store.add_provider(
            ProviderCreate(
                id="lm",
                name="LM",
                api_base="http://x",
                extra_headers={"X-Auth": "real", "X-Other": "v"},
            )
        )
        store.update_provider("lm", ProviderUpdate(extra_headers={"X-Auth": MASK}))
        provider = next(p for p in store.list_providers() if p.id == "lm")
        assert provider.extra_headers == {"X-Auth": "real"}
