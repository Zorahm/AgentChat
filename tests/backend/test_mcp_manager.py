"""Lifecycle tests for MCPManager — the parts that used to race.

Three defects are pinned here:

1. The session's ``AsyncExitStack`` was entered in a request task and closed by
   the reaper. anyio binds a cancel scope to the entering task, so the close
   raised "Attempted to exit cancel scope in a different task", was swallowed,
   and the subprocess leaked. The stack must now open and close in one task.
2. ``call_tool`` did ``self._handles[cfg.id]`` right after ``ensure_started``
   released the spawn lock — a tear-down landing in that window raised KeyError.
3. Tear-down closed the session without taking the handle lock, pulling the
   transport out from under an in-flight call.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from schemas.mcp import MCPServerConfig, MCPStdioConfig  # noqa: E402
from mcp_integration.manager import MCPManager  # noqa: E402


def _cfg(server_id: str = "srv") -> MCPServerConfig:
    return MCPServerConfig(
        id=server_id,
        name=server_id,
        enabled=True,
        config=MCPStdioConfig(type="stdio", command="true", args=[], env={}),
    )


class _FakeTool:
    def __init__(self, name: str) -> None:
        self.name = name
        self.description = "fake"
        self.inputSchema: dict[str, Any] = {"type": "object", "properties": {}}


class _FakeToolsResponse:
    def __init__(self) -> None:
        self.tools = [_FakeTool("do_thing")]


class _FakeSession:
    """Stand-in for ClientSession; records the call it was asked to make."""

    def __init__(self) -> None:
        self.call_started = asyncio.Event()
        self.release_call: asyncio.Event = asyncio.Event()

    async def list_tools(self) -> _FakeToolsResponse:
        return _FakeToolsResponse()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        self.call_started.set()
        await self.release_call.wait()
        return type("Result", (), {"isError": False, "content": [type("B", (), {"text": "ok"})()]})()


class _Transport:
    """Async CM that records which task entered and which task exited it.

    This is the whole point of the fix: anyio's transports care, and the two
    task names must match.
    """

    def __init__(self, log: dict[str, str]) -> None:
        self._log = log

    async def __aenter__(self) -> None:
        task = asyncio.current_task()
        self._log["entered_in"] = task.get_name() if task else "?"

    async def __aexit__(self, *exc: object) -> None:
        task = asyncio.current_task()
        self._log["exited_in"] = task.get_name() if task else "?"


def _patch_open_session(
    monkeypatch: pytest.MonkeyPatch, log: dict[str, str], session: _FakeSession
) -> None:
    async def fake_open_session(cfg: MCPServerConfig, stack: Any) -> _FakeSession:
        await stack.enter_async_context(_Transport(log))
        return session

    monkeypatch.setattr("mcp_integration.manager.open_session", fake_open_session)


@pytest.mark.asyncio
async def test_stack_is_closed_by_the_task_that_opened_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log: dict[str, str] = {}
    _patch_open_session(monkeypatch, log, _FakeSession())
    manager = MCPManager()

    await manager.ensure_started(_cfg())
    # Tear down from a DIFFERENT task — that is the whole scenario. The reaper
    # is a background task, so with the old code (stack.aclose() called by
    # whoever asked) the exit landed in a task that never entered the scope.
    # Calling stop() inline would exercise nothing.
    await asyncio.ensure_future(manager.stop("srv", reason="test"))

    assert log["entered_in"] == log["exited_in"]
    assert log["entered_in"].startswith("mcp-session-")


@pytest.mark.asyncio
async def test_tear_down_waits_for_an_in_flight_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _FakeSession()
    _patch_open_session(monkeypatch, {}, session)
    manager = MCPManager()
    cfg = _cfg()

    call = asyncio.ensure_future(manager.call_tool(cfg, "do_thing", {}))
    await session.call_started.wait()

    stop = asyncio.ensure_future(manager.stop("srv", reason="test"))
    await asyncio.sleep(0)  # let stop() get as far as it can

    # The call still holds the handle lock, so tear-down must not have finished.
    assert not stop.done()

    session.release_call.set()
    assert await call == "ok"
    await stop
    assert manager.get_status("srv").state == "stopped"


@pytest.mark.asyncio
async def test_call_tool_survives_a_tear_down_after_ensure_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _FakeSession()
    session.release_call.set()  # calls return immediately
    _patch_open_session(monkeypatch, {}, session)
    manager = MCPManager()
    cfg = _cfg()

    real_ensure = manager.ensure_started
    dropped = False

    async def ensure_then_drop(c: MCPServerConfig) -> Any:
        """Reproduce the race: the handle vanishes the instant the spawn lock
        is released, exactly where call_tool used to index _handles blindly."""
        nonlocal dropped
        tools = await real_ensure(c)
        if not dropped:
            dropped = True
            manager._handles.pop(c.id, None)
        return tools

    monkeypatch.setattr(manager, "ensure_started", ensure_then_drop)

    assert await manager.call_tool(cfg, "do_thing", {}) == "ok"

    monkeypatch.undo()
    await manager.shutdown()


@pytest.mark.asyncio
async def test_spawn_failure_reports_and_leaves_nothing_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failing_open_session(cfg: MCPServerConfig, stack: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr("mcp_integration.manager.open_session", failing_open_session)
    manager = MCPManager()

    with pytest.raises(RuntimeError, match="boom"):
        await manager.ensure_started(_cfg())

    status = manager.get_status("srv")
    assert status.state == "error"
    assert status.last_error == "boom"
    assert "srv" not in manager._handles


@pytest.mark.asyncio
async def test_forget_clears_per_server_bookkeeping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failing_open_session(cfg: MCPServerConfig, stack: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr("mcp_integration.manager.open_session", failing_open_session)
    manager = MCPManager()
    with pytest.raises(RuntimeError):
        await manager.ensure_started(_cfg())

    manager.forget("srv")
    assert "srv" not in manager._errors
    assert "srv" not in manager._spawn_locks
