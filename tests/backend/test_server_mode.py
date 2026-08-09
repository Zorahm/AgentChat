"""Server mode: the backend as a shared host rather than a desktop sidecar.

The property under test is the one that makes the mode safe to expose: with a
reverse proxy in front, every request reaches the app from 127.0.0.1, so the
loopback exemption that a desktop backend relies on must be *gone*. A
regression here doesn't fail loudly — it silently serves the whole internet an
unauthenticated shell on the box.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
import server_mode  # noqa: E402
from schemas.settings import SettingsUpdate  # noqa: E402
from store.settings_store import SettingsStore  # noqa: E402

fastapi_testclient = pytest.importorskip("fastapi.testclient")
TestClient = fastapi_testclient.TestClient

TOKEN = "server-mode-test-token"


@pytest.fixture
def loopback_client(tmp_path: Path):
    """A TestClient whose requests present themselves as coming from 127.0.0.1.

    That is precisely what a reverse proxy does, so this fixture is the proxy
    the guard has to defend against. The settings store is swapped for an
    isolated one because the app was built against the developer's data dir.
    """
    store = SettingsStore(settings_path=tmp_path / "settings.json")
    original = main.app.state.settings_store
    main.app.state.settings_store = store
    try:
        yield TestClient(main.app, client=("127.0.0.1", 54321)), store
    finally:
        main.app.state.settings_store = original


@pytest.fixture
def server_mode_env(monkeypatch: pytest.MonkeyPatch):
    """Turn server mode on with a known token."""
    monkeypatch.setenv(server_mode.MODE_ENV, "1")
    monkeypatch.setenv(server_mode.TOKEN_ENV, TOKEN)


class TestLoopbackExemption:
    def test_loopback_is_exempt_without_server_mode(self, loopback_client) -> None:
        """The desktop app talks to its own sidecar over loopback, unguarded."""
        client, _store = loopback_client
        assert client.get("/api/health").status_code == 200

    def test_loopback_needs_a_token_in_server_mode(
        self, loopback_client, server_mode_env
    ) -> None:
        client, _store = loopback_client
        assert client.get("/api/health").status_code == 401

    def test_loopback_with_a_wrong_token_is_rejected(
        self, loopback_client, server_mode_env
    ) -> None:
        client, _store = loopback_client
        resp = client.get("/api/health", headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401

    def test_loopback_with_the_right_token_passes(
        self, loopback_client, server_mode_env
    ) -> None:
        client, _store = loopback_client
        resp = client.get("/api/health", headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.status_code == 200

    def test_the_stored_remote_toggle_is_irrelevant(
        self, loopback_client, server_mode_env
    ) -> None:
        """settings.json can't lock a server out of itself, or open it up."""
        client, store = loopback_client
        assert store.remote_access_enabled is True  # forced on by the mode
        store.update(SettingsUpdate(remote_access_enabled=False))
        resp = client.get("/api/health", headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.status_code == 200


class TestPairingEndpointIsHidden:
    def test_get_is_not_found(self, loopback_client, server_mode_env) -> None:
        client, _store = loopback_client
        resp = client.get("/api/remote-access", headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.status_code == 404

    def test_rotate_is_not_found(self, loopback_client, server_mode_env) -> None:
        client, _store = loopback_client
        resp = client.post(
            "/api/remote-access/rotate", headers={"Authorization": f"Bearer {TOKEN}"}
        )
        assert resp.status_code == 404

    def test_system_status_advertises_the_mode(
        self, loopback_client, server_mode_env
    ) -> None:
        """The client hides local-only affordances off this flag."""
        client, _store = loopback_client
        resp = client.get("/api/system-status", headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.status_code == 200
        assert resp.json()["server_mode"] is True


class TestTokenResolution:
    def test_env_token_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(server_mode.TOKEN_ENV, TOKEN)
        assert server_mode.server_token() == TOKEN
        assert server_mode.token_origin() == f"${server_mode.TOKEN_ENV}"

    def test_token_file_is_minted_once(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(server_mode.TOKEN_ENV, raising=False)
        monkeypatch.setattr(server_mode, "TOKEN_FILE", tmp_path / "server-token")
        monkeypatch.setattr(server_mode, "_file_token", None)

        first = server_mode.server_token()
        assert first
        # Reread from disk rather than from the memo — a second process must
        # agree with the first, or every restart would revoke paired clients.
        monkeypatch.setattr(server_mode, "_file_token", None)
        assert server_mode.server_token() == first
        assert server_mode.token_origin() == str(tmp_path / "server-token")

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
    def test_token_file_is_not_world_readable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(server_mode.TOKEN_ENV, raising=False)
        token_file = tmp_path / "server-token"
        monkeypatch.setattr(server_mode, "TOKEN_FILE", token_file)
        monkeypatch.setattr(server_mode, "_file_token", None)

        server_mode.server_token()

        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600

    def test_settings_store_serves_the_server_token(
        self, tmp_path: Path, server_mode_env
    ) -> None:
        """The guard reads through the store, so the override lives there too."""
        store = SettingsStore(settings_path=tmp_path / "settings.json")
        assert store.remote_token == TOKEN
