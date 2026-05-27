"""Tests for the remote-access token guard and pairing endpoint."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from api.schemas.settings import SettingsUpdate  # noqa: E402
from main import SettingsStore, _is_loopback_client  # noqa: E402

fastapi_testclient = pytest.importorskip("fastapi.testclient")
TestClient = fastapi_testclient.TestClient


def _fake_request(host: str | None) -> SimpleNamespace:
    client = None if host is None else SimpleNamespace(host=host)
    return SimpleNamespace(client=client)


class TestIsLoopbackClient:
    def test_ipv4_loopback(self) -> None:
        assert _is_loopback_client(_fake_request("127.0.0.1")) is True

    def test_ipv6_loopback(self) -> None:
        assert _is_loopback_client(_fake_request("::1")) is True

    def test_tailscale_address_is_remote(self) -> None:
        assert _is_loopback_client(_fake_request("100.64.0.7")) is False

    def test_missing_client_is_remote(self) -> None:
        assert _is_loopback_client(_fake_request(None)) is False


@pytest.fixture
def client_with_temp_store(tmp_path: Path):
    """TestClient over the real app, but with an isolated settings store.

    TestClient requests carry the synthetic client host "testclient", so the
    guard treats them as remote — exactly the path we want to exercise.
    """
    store = SettingsStore(settings_path=tmp_path / "settings.json")
    original = main.app.state.settings_store
    main.app.state.settings_store = store
    try:
        yield TestClient(main.app), store
    finally:
        main.app.state.settings_store = original


class TestRemoteAccessGuard:
    def test_blocks_api_when_remote_disabled(self, client_with_temp_store) -> None:
        client, _store = client_with_temp_store
        assert client.get("/api/health").status_code == 401

    def test_blocks_api_when_token_missing(self, client_with_temp_store) -> None:
        client, store = client_with_temp_store
        store.update(SettingsUpdate(remote_access_enabled=True))
        assert client.get("/api/health").status_code == 401

    def test_blocks_api_with_wrong_token(self, client_with_temp_store) -> None:
        client, store = client_with_temp_store
        store.update(SettingsUpdate(remote_access_enabled=True))
        resp = client.get("/api/health", headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401

    def test_allows_api_with_correct_token(self, client_with_temp_store) -> None:
        client, store = client_with_temp_store
        store.update(SettingsUpdate(remote_access_enabled=True))
        resp = client.get("/api/health", headers={"Authorization": f"Bearer {store.remote_token}"})
        assert resp.status_code == 200

    def test_static_shell_is_public(self, client_with_temp_store) -> None:
        # The SPA shell must load without a token so the phone can read its
        # ?token=. Skipped when the UI hasn't been built (no static mount).
        client, _store = client_with_temp_store
        index = client.get("/")
        if index.status_code == 404:
            pytest.skip("ui/dist not built — static serving disabled")
        assert index.status_code == 200
        assert client.get("/manifest.webmanifest").status_code == 200

    def test_pairing_endpoint_refuses_remote_callers(self, client_with_temp_store) -> None:
        client, store = client_with_temp_store
        store.update(SettingsUpdate(remote_access_enabled=True))
        # Even with a valid token, the token-revealing endpoint is loopback-only.
        resp = client.get(
            "/api/remote-access", headers={"Authorization": f"Bearer {store.remote_token}"}
        )
        assert resp.status_code == 403

    def test_token_minted_once_and_reused(self, tmp_path: Path) -> None:
        store = SettingsStore(settings_path=tmp_path / "settings.json")
        assert store.remote_token == ""
        store.update(SettingsUpdate(remote_access_enabled=True))
        first = store.remote_token
        assert first
        store.update(SettingsUpdate(remote_access_enabled=False))
        store.update(SettingsUpdate(remote_access_enabled=True))
        assert store.remote_token == first
