"""MCP server CRUD + connectivity tests."""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from api.schemas.mcp import (
    MCPImportPayload,
    MCPInstallRequest,
    MCPInstallResult,
    MCPServerView,
    MCPTestResult,
    MCPToolView,
)
from mcp_integration.config import (
    MCPHttpConfig,
    MCPServerConfig,
    MCPServerCreate,
    MCPServerUpdate,
    MCPStdioConfig,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp", tags=["mcp"])

# Installers (npx/uvx) may download packages on first run — give them room,
# but cap it so a hung command can't pin the request forever.
_INSTALL_TIMEOUT_S = 300


def _view(cfg: MCPServerConfig, request: Request) -> MCPServerView:
    manager = request.app.state.mcp_manager
    status = manager.get_status(cfg.id)
    return MCPServerView(
        id=cfg.id,
        name=cfg.name,
        enabled=cfg.enabled,
        config=cfg.config.model_dump(),
        state=status.state,
        last_error=status.last_error,
        tool_count=len(status.tools),
        last_used=status.last_used,
    )


@router.post("/config-dir/open")
async def open_config_dir() -> dict[str, str]:
    """Open the AgentChat config folder in the OS file manager."""
    from main import AGENTS_DIR

    path = str(AGENTS_DIR)
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", path])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"path": path}


@router.post("/install", response_model=MCPInstallResult)
async def run_install_command(body: MCPInstallRequest) -> MCPInstallResult:
    """Run a one-shot MCP install command on the host shell and return its output.

    This deliberately executes the user-supplied command verbatim — it is a
    convenience for the install lines MCP servers print in their README (the
    user could equally paste them into their own terminal). It always runs on
    the host (PowerShell or CMD on Windows; ``/bin/sh`` elsewhere), never WSL.
    stdout and stderr are merged so the UI shows everything in order.
    """
    command = body.command.strip()
    if not command:
        raise HTTPException(status_code=400, detail="Empty command")

    if sys.platform == "win32":
        if body.shell == "cmd":
            argv = ["cmd.exe", "/c", command]
        else:
            argv = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]
    else:
        # Non-Windows hosts: a plain login shell. Still the host, not WSL.
        argv = ["/bin/sh", "-lc", command]

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=f"Shell not found: {exc}") from exc

    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=_INSTALL_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return MCPInstallResult(
            ok=False,
            exit_code=-1,
            output=f"… killed after {_INSTALL_TIMEOUT_S}s timeout",
            timed_out=True,
        )

    code = proc.returncode if proc.returncode is not None else -1
    return MCPInstallResult(
        ok=code == 0,
        exit_code=code,
        output=out.decode("utf-8", errors="replace"),
    )


@router.get("/servers", response_model=list[MCPServerView])
async def list_servers(request: Request) -> list[MCPServerView]:
    store = request.app.state.settings_store
    return [_view(cfg, request) for cfg in store.list_mcp_servers()]


@router.post("/servers", response_model=MCPServerView)
async def add_server(request: Request, body: MCPServerCreate) -> MCPServerView:
    store = request.app.state.settings_store
    cfg = MCPServerConfig(
        id=body.id,
        name=body.name,
        enabled=body.enabled,
        config=body.config,
    )
    try:
        store.add_mcp_server(cfg)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _view(cfg, request)


@router.put("/servers/{server_id}", response_model=MCPServerView)
async def update_server(
    request: Request, server_id: str, body: MCPServerUpdate
) -> MCPServerView:
    store = request.app.state.settings_store
    try:
        cfg = store.update_mcp_server(server_id, body)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Config or enabled flag changed — drop any cached connection so the
    # next call re-spawns with the fresh parameters.
    await request.app.state.mcp_manager._tear_down(server_id, reason="config update")
    return _view(cfg, request)


@router.delete("/servers/{server_id}")
async def delete_server(request: Request, server_id: str) -> dict[str, str]:
    store = request.app.state.settings_store
    try:
        store.remove_mcp_server(server_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await request.app.state.mcp_manager._tear_down(server_id, reason="deleted")
    return {"status": "ok"}


@router.post("/servers/{server_id}/test", response_model=MCPTestResult)
async def test_server(request: Request, server_id: str) -> MCPTestResult:
    store = request.app.state.settings_store
    cfg = store.get_mcp_server(server_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Unknown MCP server: {server_id}")
    if not cfg.enabled:
        raise HTTPException(
            status_code=400, detail=f"MCP server '{server_id}' is disabled"
        )

    manager = request.app.state.mcp_manager
    try:
        tools = await manager.list_tools_fresh(cfg)
    except Exception as exc:  # noqa: BLE001
        return MCPTestResult(ok=False, error=str(exc) or exc.__class__.__name__)
    return MCPTestResult(
        ok=True,
        tools=[
            MCPToolView(
                name=t.name,
                description=t.description,
                input_schema=t.input_schema,
            )
            for t in tools
        ],
    )


@router.post("/servers/import", response_model=list[MCPServerView])
async def import_servers(
    request: Request, body: MCPImportPayload
) -> list[MCPServerView]:
    """Accept claude_desktop_config.json shape and merge into settings.

    Each new id is added; existing ids are overwritten. Malformed entries
    are skipped with a warning rather than failing the whole import.
    """
    source = body.mcpServers or body.servers or {}
    if not source:
        raise HTTPException(
            status_code=400,
            detail="No servers in payload — expected an 'mcpServers' or 'servers' object",
        )

    store = request.app.state.settings_store
    added: list[MCPServerConfig] = []
    skipped: list[str] = []

    for raw_id, raw_cfg in source.items():
        cfg = _coerce_import_entry(raw_id, raw_cfg)
        if cfg is None:
            skipped.append(raw_id)
            continue
        store.upsert_mcp_server(cfg)
        added.append(cfg)

    if skipped:
        logger.warning("MCP import skipped malformed entries: %s", ", ".join(skipped))

    # Re-load with status info from the manager.
    return [_view(cfg, request) for cfg in added]


def _coerce_import_entry(server_id: str, raw: Any) -> MCPServerConfig | None:
    """Translate one import entry into :class:`MCPServerConfig` or ``None``."""
    if not isinstance(raw, dict):
        return None
    try:
        if "url" in raw:
            transport: MCPStdioConfig | MCPHttpConfig = MCPHttpConfig(
                url=str(raw["url"]),
                headers={str(k): str(v) for k, v in (raw.get("headers") or {}).items()},
            )
        elif "command" in raw:
            transport = MCPStdioConfig(
                command=str(raw["command"]),
                args=[str(a) for a in (raw.get("args") or [])],
                env={str(k): str(v) for k, v in (raw.get("env") or {}).items()},
                runtime="wsl" if raw.get("runtime") == "wsl" else "host",
            )
        else:
            return None
        return MCPServerConfig(
            id=server_id,
            name=str(raw.get("name") or server_id),
            enabled=bool(raw.get("enabled", True)),
            config=transport,
        )
    except Exception:  # noqa: BLE001
        return None
