"""SearXNG management API — Docker-in-WSL install + status for web search.

Mirrors the WSL install-deps pattern: a background task writes progress to
module-level state; the frontend polls /searxng/install/status. On success the
container's URL (http://localhost:8080) is written into settings as
``searxng_url`` so the self-hosted web-search mode lights up immediately.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import shlex
from collections.abc import Callable

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel

from agent.wsl_exec import decode_loose, wsl_run, wsl_write_bytes

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/searxng", tags=["searxng"])

_CONTAINER = "agentchat-searxng"
_PORT = 8080
_URL = f"http://localhost:{_PORT}"

_install_task: asyncio.Task[None] | None = None
_install_log: list[str] = []
_install_error: str | None = None


# ── Models ──────────────────────────────────────────────────────────────────


class SearxngStatus(BaseModel):
    wsl_available: bool
    docker_available: bool  # docker CLI present AND daemon reachable
    docker_cli: bool  # docker binary on PATH (daemon may still be down)
    running: bool  # the agentchat-searxng container is up
    url: str | None  # configured searxng_url, if any
    installing: bool


class SearxngInstallStatus(BaseModel):
    running: bool
    log: str
    error: str | None
    url: str | None


class ActionResult(BaseModel):
    success: bool
    output: str


# ── settings.yml ─────────────────────────────────────────────────────────────

# Enables the JSON output format our client needs (disabled by default) and
# turns off the bot limiter so server-to-server queries aren't rejected.
def _settings_yml(secret_key: str) -> str:
    return (
        "use_default_settings: true\n"
        "server:\n"
        f'  secret_key: "{secret_key}"\n'
        "  limiter: false\n"
        "  image_proxy: false\n"
        "search:\n"
        "  formats:\n"
        "    - html\n"
        "    - json\n"
    )


# ── helpers ───────────────────────────────────────────────────────────────


async def _wsl_ok() -> bool:
    import shutil

    return shutil.which("wsl") is not None


async def _wsl_home() -> str | None:
    """Resolve $HOME inside WSL. Referencing $HOME in `bash -lc` works on this
    host; assigning shell variables does not (silently empty), so all paths are
    built from this Python string instead of in-shell vars."""
    r = await wsl_run("echo $HOME", timeout=15)
    if r.returncode != 0:
        return None
    home = decode_loose(r.stdout).strip()
    return home or None


async def _docker_cli() -> bool:
    r = await wsl_run("command -v docker >/dev/null 2>&1", timeout=15)
    return r.returncode == 0


async def _docker_daemon() -> bool:
    r = await wsl_run("docker info >/dev/null 2>&1", timeout=20)
    return r.returncode == 0


async def _container_running() -> bool:
    r = await wsl_run(
        f"docker ps --filter name=^/{_CONTAINER}$ --filter status=running -q",
        timeout=20,
    )
    return r.returncode == 0 and bool(decode_loose(r.stdout).strip())


async def _health_ok() -> bool:
    """Probe the JSON endpoint from the Windows side (WSL2 forwards localhost)."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{_URL}/search", params={"q": "ping", "format": "json"})
        return resp.status_code == 200
    except Exception:
        return False


# ── routes ──────────────────────────────────────────────────────────────────


@router.get("/status", response_model=SearxngStatus)
async def status(request: Request) -> SearxngStatus:
    store = request.app.state.settings_store
    wsl = await _wsl_ok()
    cli = await _docker_cli() if wsl else False
    daemon = await _docker_daemon() if cli else False
    running = await _container_running() if daemon else False
    return SearxngStatus(
        wsl_available=wsl,
        docker_available=daemon,
        docker_cli=cli,
        running=running,
        url=store.searxng_url,
        installing=_install_task is not None and not _install_task.done(),
    )


async def _run_install(set_url: Callable[[str], None]) -> None:
    global _install_error
    _install_error = None
    _install_log.clear()

    def emit(line: str) -> None:
        logger.info("searxng-install: %s", line)
        _install_log.append(line)

    try:
        if not await _docker_cli():
            _install_error = (
                "Docker is not installed in WSL. Install Docker (or enable Docker "
                "Desktop WSL integration), then try again."
            )
            return
        if not await _docker_daemon():
            emit("Docker daemon not reachable — trying to start it…")
            await wsl_run("sudo service docker start >/dev/null 2>&1 || true", timeout=30)
            if not await _docker_daemon():
                _install_error = (
                    "Docker daemon is not running. Start Docker Desktop (with WSL "
                    "integration) or run `sudo service docker start` in WSL."
                )
                return

        home = await _wsl_home()
        if not home:
            _install_error = "Could not resolve the WSL home directory ($HOME was empty)."
            return
        settings_dir = f"{home}/AgentChat/searxng"
        settings_path = f"{settings_dir}/settings.yml"

        # Write settings.yml once (preserve an existing secret_key on reinstall).
        exists = await wsl_run(f"test -f {shlex.quote(settings_path)}", timeout=15)
        if exists.returncode != 0:
            emit("Writing settings.yml (JSON output enabled)…")
            await wsl_write_bytes(settings_path, _settings_yml(secrets.token_hex(32)).encode())

        emit("Pulling searxng/searxng and starting the container (first run takes a few minutes)…")
        # No shell variable assignments — this host returns them empty inside
        # `bash -lc`. Paths are literal Python strings, quoted for the shell.
        vol = shlex.quote(f"{settings_dir}:/etc/searxng")
        run_cmd = (
            "docker rm -f agentchat-searxng >/dev/null 2>&1 || true; "
            "docker pull searxng/searxng:latest && "
            "docker run -d --name agentchat-searxng --restart unless-stopped "
            f"-p 8080:8080 -v {vol} searxng/searxng:latest"
        )
        r = await wsl_run(run_cmd, timeout=900)
        tail = "\n".join(filter(None, [decode_loose(r.stdout).strip(), decode_loose(r.stderr).strip()]))
        if tail:
            emit(tail[-2000:])
        if r.returncode != 0:
            _install_error = f"docker run failed (exit {r.returncode}) — see log."
            return

        emit("Container started. Waiting for SearXNG to answer JSON queries…")
        for _ in range(20):
            if await _health_ok():
                set_url(_URL)
                emit(f"✓ SearXNG is up at {_URL} and answering JSON. Saved as the SearXNG URL.")
                return
            await asyncio.sleep(2)
        _install_error = (
            "Container is running but did not answer a JSON query in time. "
            "Check the container logs (docker logs agentchat-searxng)."
        )
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("searxng install failed")
        _install_error = f"Unexpected error: {exc}"


@router.post("/install", response_model=ActionResult)
async def install(request: Request) -> ActionResult:
    """Install + run SearXNG via Docker in WSL. Returns immediately; poll
    /searxng/install/status for progress."""
    global _install_task
    if _install_task and not _install_task.done():
        return ActionResult(success=True, output="Install already running.")

    store = request.app.state.settings_store

    def set_url(url: str) -> None:
        from api.schemas.settings import SettingsUpdate

        store.update(SettingsUpdate(searxng_url=url))

    _install_task = asyncio.create_task(_run_install(set_url))
    return ActionResult(success=True, output="SearXNG install started.")


@router.get("/install/status", response_model=SearxngInstallStatus)
async def install_status(request: Request) -> SearxngInstallStatus:
    store = request.app.state.settings_store
    running = _install_task is not None and not _install_task.done()
    return SearxngInstallStatus(
        running=running,
        log="\n".join(_install_log),
        error=_install_error,
        url=store.searxng_url,
    )


@router.post("/stop", response_model=ActionResult)
async def stop() -> ActionResult:
    """Stop the SearXNG container (leaves it installed)."""
    r = await wsl_run(f"docker stop {_CONTAINER}", timeout=30)
    out = decode_loose(r.stdout).strip() or decode_loose(r.stderr).strip()
    return ActionResult(success=r.returncode == 0, output=out or "stopped")
