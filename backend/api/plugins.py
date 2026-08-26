"""Agent Plugins REST API — install, list, toggle, remove.

Every mutation ends the same way: rebuild the registry, push the resulting
skills into the shared index, and stop any MCP server the change took away.
That last step is the one that is easy to forget — a disabled plugin whose
server is still running is a plugin that is still running.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from fastapi import APIRouter, HTTPException, Request, UploadFile

from mcp_integration.manager import MCPManager
from plugins.installer import PluginInstaller
from plugins.mcp_config import PluginMCPServer
from plugins.registry import LoadedPlugin, PluginRegistry
from schemas.plugins import (
    PluginInfo,
    PluginInstallLocalRequest,
    PluginInstallRequest,
    PluginMCPServerInfo,
    PluginSkillInfo,
    PluginUpdateRequest,
)
from skills.install_marker import read_marker

router = APIRouter(prefix="/plugins", tags=["plugins"])

_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024  # same cap as a skill upload


def _to_info(plugin: LoadedPlugin, request: Request) -> PluginInfo:
    manager = request.app.state.mcp_manager
    installer: PluginInstaller = request.app.state.plugin_installer
    manifest = plugin.manifest
    author = manifest.author.name if manifest and manifest.author else None
    return PluginInfo(
        name=plugin.name,
        path=str(plugin.root),
        valid=plugin.valid,
        enabled=plugin.enabled,
        version=manifest.version if manifest else None,
        description=manifest.description if manifest else None,
        author=author,
        homepage=manifest.homepage if manifest else None,
        repository=manifest.repository if manifest else None,
        license=manifest.license if manifest else None,
        keywords=list(manifest.keywords or []) if manifest else [],
        source=read_marker(plugin.root).get("source"),
        installed_by_us=installer.is_installed_by_us(plugin.name),
        skills=[
            PluginSkillInfo(name=s.name, description=s.description, path=str(s.path))
            for s in plugin.skills
        ],
        mcp_servers=[_server_info(server, manager) for server in plugin.mcp_servers],
        issues=list(plugin.issues),
    )


def _server_info(server: PluginMCPServer, manager: MCPManager) -> PluginMCPServerInfo:
    status = manager.get_status(server.config.id)
    return PluginMCPServerInfo(
        id=server.config.id,
        key=server.key,
        transport=server.transport,
        state=status.state,
        last_error=status.last_error,
        tool_count=len(status.tools),
    )


# Starlette's ``State`` is an untyped attribute bag, so the app factory's
# guarantee has to be restated here for the type checker.
def _registry(request: Request) -> PluginRegistry:
    return cast(PluginRegistry, request.app.state.plugin_registry)


def _installer(request: Request) -> PluginInstaller:
    return cast(PluginInstaller, request.app.state.plugin_installer)


async def _resync(request: Request, *, stopped_ids: list[str] | None = None) -> None:
    """Re-derive everything a plugin contributes after a change.

    *stopped_ids* are servers that existed before the change; any of them the
    registry no longer offers is torn down, so a disabled or uninstalled
    plugin cannot leave a live subprocess behind.
    """
    registry = _registry(request)
    registry.invalidate()
    registry.rebuild(force=True)
    registry.apply_to_reader(request.app.state.skill_reader)

    if not stopped_ids:
        return
    surviving = {cfg.id for cfg in registry.mcp_servers()}
    manager = request.app.state.mcp_manager
    for server_id in stopped_ids:
        if server_id in surviving:
            continue
        await manager.stop(server_id, reason="plugin changed")
        manager.forget(server_id)


def _server_ids(request: Request) -> list[str]:
    return [cfg.id for cfg in _registry(request).mcp_servers()]


@router.get("", response_model=list[PluginInfo])
async def list_plugins(request: Request) -> list[PluginInfo]:
    registry = _registry(request)
    registry.set_disabled(request.app.state.settings_store.list_disabled_plugins())
    plugins = registry.list_plugins()
    registry.apply_to_reader(request.app.state.skill_reader)
    return [_to_info(p, request) for p in plugins]


@router.get("/location")
async def plugins_location(request: Request) -> dict[str, str]:
    """Where packages and their persistent data live, for the UI's hint line."""
    registry = _registry(request)
    return {"plugins_dir": str(registry.plugins_dir), "data_dir": str(registry.data_dir)}


@router.post("/install", response_model=PluginInfo)
async def install_plugin(request: Request, body: PluginInstallRequest) -> PluginInfo:
    before = _server_ids(request)
    try:
        plugin = _installer(request).install_from_github(body.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await _resync(request, stopped_ids=before)
    return _to_info(plugin, request)


@router.post("/install-local", response_model=PluginInfo)
async def install_local_plugin(
    request: Request, body: PluginInstallLocalRequest
) -> PluginInfo:
    before = _server_ids(request)
    try:
        plugin = _installer(request).install_local(Path(body.path).expanduser())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await _resync(request, stopped_ids=before)
    return _to_info(plugin, request)


@router.post("/upload", response_model=PluginInfo)
async def upload_plugin(request: Request, file: UploadFile) -> PluginInfo:
    data = await file.read()
    if len(data) > _MAX_ARCHIVE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Archive is larger than {_MAX_ARCHIVE_BYTES // (1024 * 1024)} MB",
        )
    before = _server_ids(request)
    try:
        plugin = _installer(request).install_from_archive(data, file.filename or "plugin.zip")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await _resync(request, stopped_ids=before)
    return _to_info(plugin, request)


@router.get("/{name}", response_model=PluginInfo)
async def get_plugin(request: Request, name: str) -> PluginInfo:
    plugin = _registry(request).get(name)
    if plugin is None:
        raise HTTPException(status_code=404, detail=f"Unknown plugin: {name}")
    return _to_info(plugin, request)


@router.put("/{name}", response_model=PluginInfo)
async def update_plugin(
    request: Request, name: str, body: PluginUpdateRequest
) -> PluginInfo:
    registry = _registry(request)
    if registry.get(name) is None:
        raise HTTPException(status_code=404, detail=f"Unknown plugin: {name}")

    before = _server_ids(request)
    store = request.app.state.settings_store
    store.set_plugin_enabled(name, body.enabled)
    registry.set_disabled(store.list_disabled_plugins())
    await _resync(request, stopped_ids=before)

    plugin = registry.get(name)
    if plugin is None:  # pragma: no cover — it existed a moment ago
        raise HTTPException(status_code=404, detail=f"Unknown plugin: {name}")
    return _to_info(plugin, request)


@router.delete("/{name}")
async def delete_plugin(request: Request, name: str) -> dict[str, str]:
    before = _server_ids(request)
    try:
        _installer(request).uninstall(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await _resync(request, stopped_ids=before)
    return {"status": "ok"}
