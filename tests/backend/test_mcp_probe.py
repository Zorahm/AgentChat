"""POST /mcp/probe — the automatic equivalent of pressing Test on every card.

Pins the behaviour the green dot depends on: the manager spawns lazily, so
``GET /servers`` reports "stopped" for a server nobody has used yet. Before the
probe existed that made a perfectly healthy connector look broken until the user
found the Test button.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.mcp import router as mcp_router  # noqa: E402
from mcp_integration.manager import MCPManager  # noqa: E402
from plugins.registry import PluginRegistry  # noqa: E402
from schemas.mcp import MCPServerConfig, MCPStdioConfig  # noqa: E402
from store.settings_store import SettingsStore  # noqa: E402

fastapi = pytest.importorskip("fastapi")
fastapi_testclient = pytest.importorskip("fastapi.testclient")
TestClient = fastapi_testclient.TestClient

# open_session raises for this id, standing in for a server whose command is
# missing or whose URL is unreachable.
BROKEN_ID = "broken"


class _FakeTool:
    def __init__(self, name: str) -> None:
        self.name = name
        self.description = "fake"
        self.inputSchema: dict[str, Any] = {"type": "object", "properties": {}}


class _FakeSession:
    def __init__(self, tool_count: int) -> None:
        self._tool_count = tool_count

    async def list_tools(self) -> Any:
        return type("R", (), {"tools": [_FakeTool(f"t{i}") for i in range(self._tool_count)]})()


def _cfg(server_id: str, *, enabled: bool = True) -> MCPServerConfig:
    return MCPServerConfig(
        id=server_id,
        name=server_id,
        enabled=enabled,
        config=MCPStdioConfig(type="stdio", command="true", args=[], env={}),
    )


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    spawned: list[str] = []

    async def fake_open_session(cfg: MCPServerConfig, stack: Any) -> _FakeSession:
        spawned.append(cfg.id)
        if cfg.id == BROKEN_ID:
            raise RuntimeError("spawn failed: command not found")
        return _FakeSession(tool_count=2)

    monkeypatch.setattr("mcp_integration.manager.open_session", fake_open_session)

    store = SettingsStore(settings_path=tmp_path / "settings.json")
    store.add_mcp_server(_cfg("healthy"))
    store.add_mcp_server(_cfg(BROKEN_ID))
    store.add_mcp_server(_cfg("switched-off", enabled=False))

    app = fastapi.FastAPI()
    app.include_router(mcp_router)
    app.state.settings_store = store
    app.state.mcp_manager = MCPManager()
    # The MCP routes also read plugin-contributed servers; an empty plugins
    # root gives them a registry with nothing in it.
    app.state.plugin_registry = PluginRegistry(tmp_path / "plugins", tmp_path / "plugin-data")

    test_client = TestClient(app)
    test_client.spawned = spawned  # type: ignore[attr-defined]
    return test_client


def _by_id(payload: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {row["id"]: row for row in payload}


class TestProbe:
    def test_listing_alone_cannot_report_a_live_server(self, client: Any) -> None:
        # The premise of the whole endpoint: nothing has used these servers, so
        # the lazy manager has nothing to report.
        servers = _by_id(client.get("/mcp/servers").json())
        assert servers["healthy"]["state"] == "stopped"
        assert client.spawned == []

    def test_probe_connects_and_reports_each_state(self, client: Any) -> None:
        servers = _by_id(client.post("/mcp/probe").json())

        assert servers["healthy"]["state"] == "running"
        assert servers["healthy"]["tool_count"] == 2
        assert servers[BROKEN_ID]["state"] == "error"
        assert "command not found" in (servers[BROKEN_ID]["last_error"] or "")

    def test_a_disabled_server_is_never_spawned(self, client: Any) -> None:
        servers = _by_id(client.post("/mcp/probe").json())
        # Still listed (the settings UI shows it) but untouched.
        assert servers["switched-off"]["state"] == "stopped"
        assert "switched-off" not in client.spawned

    def test_one_broken_server_does_not_sink_the_others(self, client: Any) -> None:
        # gather(return_exceptions=True) — a raising spawn must not abort the round.
        servers = _by_id(client.post("/mcp/probe").json())
        assert servers["healthy"]["state"] == "running"
        assert sorted(client.spawned) == ["broken", "healthy"]

    def test_probing_again_reuses_a_live_connection(self, client: Any) -> None:
        client.post("/mcp/probe")
        client.post("/mcp/probe")
        # ensure_started, not list_tools_fresh: re-probing must not restart a
        # server out from under a chat that is mid tool-call.
        assert client.spawned.count("healthy") == 1

    def test_a_probe_retries_a_server_that_failed_before(self, client: Any) -> None:
        client.post("/mcp/probe")
        servers = _by_id(client.post("/mcp/probe").json())
        # Nothing caches the failure — a server fixed since the last probe must
        # be able to come back without an app restart.
        assert client.spawned.count(BROKEN_ID) == 2
        assert servers[BROKEN_ID]["state"] == "error"
