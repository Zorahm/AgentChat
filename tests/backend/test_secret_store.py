"""Tests for SecretStore — the file and memory backends.

The keyring backend is deliberately never exercised: touching it would write
into whoever runs the suite's real OS credential store. ``use_keyring``
defaults to False for exactly that reason, and these tests pin that default.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from store.secret_store import SecretStore  # noqa: E402


class TestBackendSelection:
    def test_defaults_to_file_without_keyring(self, tmp_path: Path) -> None:
        assert SecretStore(tmp_path / "s.json").backend == "file"

    def test_no_path_means_memory(self) -> None:
        assert SecretStore(None).backend == "memory"


class TestRoundTrip:
    def test_set_then_get(self, tmp_path: Path) -> None:
        store = SecretStore(tmp_path / "s.json")
        store.set("provider:openai", "sk-secret")
        assert store.get("provider:openai") == "sk-secret"

    def test_missing_name_is_none(self, tmp_path: Path) -> None:
        assert SecretStore(tmp_path / "s.json").get("nope") is None

    def test_survives_reload(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        SecretStore(path).set("tavily", "tvly-x")
        assert SecretStore(path).get("tavily") == "tvly-x"

    def test_empty_value_deletes(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        store = SecretStore(path)
        store.set("tavily", "tvly-x")
        store.set("tavily", "")
        assert store.get("tavily") is None
        assert SecretStore(path).get("tavily") is None

    def test_none_deletes(self, tmp_path: Path) -> None:
        store = SecretStore(tmp_path / "s.json")
        store.set("tavily", "tvly-x")
        store.set("tavily", None)
        assert store.get("tavily") is None

    def test_memory_backend_does_not_write(self, tmp_path: Path) -> None:
        store = SecretStore(None)
        store.set("a", "b")
        assert store.get("a") == "b"
        assert list(tmp_path.iterdir()) == []


class TestFileHandling:
    def test_corrupt_file_is_ignored_not_fatal(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        path.write_text("{not json", encoding="utf-8")
        store = SecretStore(path)
        assert store.get("anything") is None
        # Still usable afterwards — a broken file must not wedge the app.
        store.set("k", "v")
        assert SecretStore(path).get("k") == "v"

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
    def test_file_is_owner_only(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        SecretStore(path).set("k", "v")
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == 0o600

    def test_write_is_atomic_leaving_no_temp_files(self, tmp_path: Path) -> None:
        SecretStore(tmp_path / "s.json").set("k", "v")
        assert [p.name for p in tmp_path.iterdir()] == ["s.json"]


class TestAbsorbFile:
    """Behaviour when a host gains a keychain after using the fallback.

    A stub stands in for the real keyring backend so the test can prove the
    handover without going anywhere near the developer's credential store.
    """

    def test_leftovers_move_into_the_keychain_and_file_is_removed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = tmp_path / "s.json"
        path.write_text(json.dumps({"provider:openai": "sk-old"}), encoding="utf-8")

        vault: dict[tuple[str, str], str] = {}
        monkeypatch.setattr("store.secret_store._select_keyring", lambda: _FakeKeyring(vault))

        store = SecretStore(path, use_keyring=True)
        assert store.backend == "keyring"
        assert store.get("provider:openai") == "sk-old"
        assert not path.exists(), "plaintext fallback must not be left behind"

    def test_existing_keychain_entry_wins_over_stale_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = tmp_path / "s.json"
        path.write_text(json.dumps({"provider:openai": "sk-stale"}), encoding="utf-8")

        vault = {("AgentChat", "provider:openai"): "sk-current"}
        monkeypatch.setattr("store.secret_store._select_keyring", lambda: _FakeKeyring(vault))

        store = SecretStore(path, use_keyring=True)
        assert store.get("provider:openai") == "sk-current"


class _FakeKeyring:
    """Minimal stand-in for a keyring backend, backed by a dict."""

    def __init__(self, vault: dict[tuple[str, str], str]) -> None:
        self._vault = vault

    def get_password(self, service: str, name: str) -> str | None:
        return self._vault.get((service, name))

    def set_password(self, service: str, name: str, value: str) -> None:
        self._vault[(service, name)] = value

    def delete_password(self, service: str, name: str) -> None:
        del self._vault[(service, name)]
