"""SearXNG management API — Docker-in-WSL install + status for web search.

Mirrors the WSL install-deps pattern: a background task writes progress to
module-level state; the frontend polls /searxng/install/status. On success the
container's URL (http://localhost:8080) is written into settings as
``searxng_url`` so the self-hosted web-search mode lights up immediately.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel

from agent.wsl_exec import decode_loose, run_capture, wsl_read_text, wsl_run, wsl_write_bytes
from shell import NO_WINDOW

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/searxng", tags=["searxng"])

_CONTAINER = "agentchat-searxng"
_PORT = 8080
_URL = f"http://localhost:{_PORT}"

_install_task: asyncio.Task[None] | None = None
_install_log: list[str] = []
_install_error: str | None = None

# Separate background task for the Docker Desktop install + WSL-integration step.
_docker_task: asyncio.Task[None] | None = None
_docker_log: list[str] = []
_docker_error: str | None = None

_DOCKER_DOWNLOAD_URL = "https://www.docker.com/products/docker-desktop/"


# ── Models ──────────────────────────────────────────────────────────────────


class SearxngStatus(BaseModel):
    wsl_available: bool
    docker_available: bool  # docker CLI present AND daemon reachable
    docker_cli: bool  # docker binary on PATH (daemon may still be down)
    docker_desktop_installed: bool  # Docker Desktop present on the Windows host
    winget_available: bool  # winget present, so we can auto-install Docker Desktop
    docker_download_url: str  # manual-install fallback link
    running: bool  # the agentchat-searxng container is up
    url: str | None  # configured searxng_url, if any
    installing: bool  # SearXNG install task is running
    installing_docker: bool  # Docker Desktop install task is running


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


# ── settings push (bypasses bind-mount) ──────────────────────────────────────

# Docker Desktop + WSL2 sometimes resolves the bind-mount source path inside
# the ``docker-desktop`` distro instead of the user's distro. The container
# then sees an empty mount, SearXNG's entrypoint writes a default
# ``settings.yml`` with JSON output OFF, and ``/search?format=json`` returns
# 403 Forbidden. ``docker cp`` goes through the daemon API and is immune.

_SECRET_KEY_RE = re.compile(r'secret_key:\s*"([^"]+)"')


def _extract_secret_key(text: str) -> str | None:
    m = _SECRET_KEY_RE.search(text)
    return m.group(1) if m else None


async def _host_secret_key(path: str) -> str | None:
    """Read the existing ``secret_key`` from the host settings.yml, if any."""
    try:
        return _extract_secret_key(await wsl_read_text(path))
    except (FileNotFoundError, OSError):
        return None


async def _container_secret_key(container: str) -> str | None:
    """Read the existing ``secret_key`` from the container's settings.yml."""
    r = await wsl_run(
        f"docker exec {shlex.quote(container)} cat /etc/searxng/settings.yml",
        timeout=20,
    )
    if r.returncode != 0:
        return None
    return _extract_secret_key(decode_loose(r.stdout))


async def _apply_settings_into_container(
    container: str, content: str
) -> tuple[bool, str | None]:
    """Push ``content`` to ``/etc/searxng/settings.yml`` inside ``container``
    via ``docker cp``, then restart the container. Returns (success, error)."""
    tmp = f"/tmp/searxng-settings-{secrets.token_hex(4)}.yml"
    try:
        try:
            await wsl_write_bytes(tmp, content.encode())
        except OSError as exc:
            return False, f"write tempfile: {exc}"
        cp = await wsl_run(
            f"docker cp {shlex.quote(tmp)} "
            f"{shlex.quote(container)}:/etc/searxng/settings.yml",
            timeout=60,
        )
        if cp.returncode != 0:
            err = decode_loose(cp.stderr).strip() or f"docker cp exit {cp.returncode}"
            return False, err
        # The image runs as ``searxng`` (uid 977); make sure it can still read
        # the file after we overwrote it as the cp user.
        await wsl_run(
            f"docker exec -u root {shlex.quote(container)} "
            f"chown searxng:searxng /etc/searxng/settings.yml",
            timeout=20,
        )
        restart = await wsl_run(
            f"docker restart {shlex.quote(container)}", timeout=60
        )
        if restart.returncode != 0:
            err = (
                decode_loose(restart.stderr).strip()
                or f"docker restart exit {restart.returncode}"
            )
            return False, err
        return True, None
    finally:
        await wsl_run(f"rm -f {shlex.quote(tmp)}", timeout=10)


async def _wait_for_health(attempts: int = 20, delay: float = 2.0) -> bool:
    """Poll the JSON endpoint until it returns 200 or attempts run out."""
    for _ in range(attempts):
        if await _health_ok():
            return True
        await asyncio.sleep(delay)
    return False


# ── Docker Desktop (Windows host) ───────────────────────────────────────────


async def _win_run(args: list[str], timeout: int = 60) -> tuple[int, str, str]:
    """Run a Windows-side command in a thread; return (returncode, out, err)."""
    return await run_capture(args, timeout=timeout)


def _docker_desktop_exe() -> str | None:
    """Locate Docker Desktop.exe in the usual install locations."""
    candidates = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Docker" / "Docker" / "Docker Desktop.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Docker" / "Docker" / "Docker Desktop.exe",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def _docker_desktop_installed() -> bool:
    return _docker_desktop_exe() is not None or shutil.which("docker") is not None


def _winget_available() -> bool:
    return shutil.which("winget") is not None


async def _default_wsl_distro() -> str | None:
    """First entry of `wsl -l -q` — the default distro Docker should integrate."""
    code, out, _ = await _win_run(["wsl.exe", "-l", "-q"], timeout=10)
    if code != 0:
        return None
    for line in out.splitlines():
        name = line.strip()
        if name:
            return name
    return None


def _patch_wsl_integration(distro: str | None) -> bool:
    """Best-effort: enable Docker Desktop's WSL2 engine + integration with the
    default (and named) distro by editing its settings file. Docker reads this
    on (re)start, so we patch BEFORE launching it. Never raises."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return False
    docker_dir = Path(appdata) / "Docker"
    target: Path | None = None
    data: dict[str, object] = {}
    for name in ("settings-store.json", "settings.json"):
        p = docker_dir / name
        if p.exists():
            target = p
            try:
                loaded = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, ValueError):
                data = {}
            break
    if target is None:
        # Fresh install — Docker hasn't created its config yet. Seed one.
        try:
            docker_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return False
        target = docker_dir / "settings-store.json"

    data["wslEngineEnabled"] = True
    data["enableIntegrationWithDefaultWslDistro"] = True
    if distro:
        existing = data.get("integratedWslDistros")
        distros = list(existing) if isinstance(existing, list) else []
        if distro not in distros:
            distros.append(distro)
        data["integratedWslDistros"] = distros
    try:
        target.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return True
    except OSError:
        return False


async def _winget_install_docker() -> tuple[int, str, str]:
    """Install Docker Desktop via winget in a UAC-elevated process, waiting for
    completion and propagating winget's exit code."""
    inner = (
        "winget install -e --id Docker.DockerDesktop "
        "--accept-source-agreements --accept-package-agreements --silent"
    )
    ps_cmd = (
        "$p = Start-Process -Verb RunAs -Wait -PassThru -FilePath 'powershell.exe' "
        "-ArgumentList '-NoProfile','-NoLogo','-Command',"
        + "'" + inner.replace("'", "''") + "'"
        + "; exit $p.ExitCode"
    )
    return await _win_run(["powershell.exe", "-NoProfile", "-Command", ps_cmd], timeout=1800)


def _start_docker_desktop() -> bool:
    """Launch Docker Desktop (non-elevated). Returns False if the exe is missing."""
    exe = _docker_desktop_exe()
    if not exe:
        return False
    try:
        subprocess.Popen([exe], creationflags=NO_WINDOW)
        return True
    except OSError:
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
        docker_desktop_installed=_docker_desktop_installed(),
        winget_available=_winget_available(),
        docker_download_url=_DOCKER_DOWNLOAD_URL,
        running=running,
        url=store.searxng_url,
        installing=_install_task is not None and not _install_task.done(),
        installing_docker=_docker_task is not None and not _docker_task.done(),
    )


class DockerInstallStatus(BaseModel):
    running: bool
    log: str
    error: str | None
    docker_available: bool


async def _run_install_docker() -> None:
    """Background worker: install Docker Desktop (winget), enable WSL
    integration, start it, and wait for the daemon. Writes progress to state."""
    global _docker_error
    _docker_error = None
    _docker_log.clear()

    def emit(line: str) -> None:
        logger.info("docker-install: %s", line)
        _docker_log.append(line)

    try:
        if not _docker_desktop_installed():
            if not _winget_available():
                _docker_error = (
                    "winget is not available, so Docker Desktop can't be installed "
                    f"automatically. Install it manually from {_DOCKER_DOWNLOAD_URL}, "
                    "enable WSL integration for your distro, then come back."
                )
                return
            emit("Installing Docker Desktop via winget (a UAC prompt will appear; this can take several minutes)…")
            code, out, err = await _winget_install_docker()
            tail = "\n".join(s for s in [(out or "").strip(), (err or "").strip()] if s)
            if tail:
                emit(tail[-2000:])
            if not _docker_desktop_installed():
                _docker_error = (
                    f"Docker Desktop install did not complete (winget exit {code}). "
                    f"Try installing it manually from {_DOCKER_DOWNLOAD_URL}."
                )
                return
            emit("Docker Desktop installed.")
        else:
            emit("Docker Desktop is already installed.")

        distro = await _default_wsl_distro()
        if _patch_wsl_integration(distro):
            emit(f"Enabled Docker WSL integration{f' for {distro}' if distro else ''} in Docker Desktop settings.")

        emit("Starting Docker Desktop…")
        if not _start_docker_desktop():
            _docker_error = (
                "Docker Desktop was installed but its executable could not be found to "
                "launch. Open Docker Desktop manually, then refresh."
            )
            return

        emit("Waiting for the Docker daemon to come up (first start can take a few minutes)…")
        for _ in range(120):  # ~4 minutes
            await asyncio.sleep(2)
            if await _docker_daemon():
                emit("✓ Docker is running and reachable from WSL.")
                return
        _docker_error = (
            "Docker Desktop is installed and starting, but the daemon isn't reachable "
            "from WSL yet. Open Docker Desktop and, once it has finished starting, go to "
            "Settings → Resources → WSL Integration, enable your distro, then Apply & "
            "Restart. A Windows restart may be required after a fresh install."
        )
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("docker install failed")
        _docker_error = f"Unexpected error: {exc}"


@router.post("/install-docker", response_model=ActionResult)
async def install_docker() -> ActionResult:
    """Install Docker Desktop + enable WSL integration, in the background.
    Poll /searxng/install-docker/status for progress."""
    global _docker_task
    if _docker_task and not _docker_task.done():
        return ActionResult(success=True, output="Docker install already running.")
    _docker_task = asyncio.create_task(_run_install_docker())
    return ActionResult(success=True, output="Docker Desktop setup started.")


@router.get("/install-docker/status", response_model=DockerInstallStatus)
async def install_docker_status() -> DockerInstallStatus:
    running = _docker_task is not None and not _docker_task.done()
    cli = await _docker_cli() if await _wsl_ok() else False
    daemon = await _docker_daemon() if cli else False
    return DockerInstallStatus(
        running=running,
        log="\n".join(_docker_log),
        error=_docker_error,
        docker_available=daemon,
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

        # Preserve an existing secret_key across reinstalls so user sessions
        # don't churn, otherwise mint a fresh one.
        secret = await _host_secret_key(settings_path) or secrets.token_hex(32)
        settings_content = _settings_yml(secret)

        # Always write the host file: it's our source of truth and lets the
        # bind-mount carry the config on setups where it works.
        emit("Writing settings.yml (JSON output enabled)…")
        await wsl_write_bytes(settings_path, settings_content.encode())

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

        # Docker Desktop on Windows resolves bind-mount sources inside its own
        # ``docker-desktop`` WSL distro rather than the user's, so SearXNG can
        # start with a default settings.yml (JSON OFF) even when our file is
        # in place on the host. ``docker cp`` makes this reliable regardless.
        emit("Pushing settings.yml into the container (docker cp)…")
        ok, msg = await _apply_settings_into_container(_CONTAINER, settings_content)
        if not ok:
            _install_error = (
                f"Could not push settings.yml into the container: {msg}"
            )
            return

        emit("Container started. Waiting for SearXNG to answer JSON queries…")
        if await _wait_for_health():
            set_url(_URL)
            emit(f"✓ SearXNG is up at {_URL} and answering JSON. Saved as the SearXNG URL.")
            return
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


@router.post("/repair", response_model=ActionResult)
async def repair() -> ActionResult:
    """Re-apply settings.yml inside the already-running container.

    Use this when the container is up but ``/search?format=json`` returns 403:
    a known Docker Desktop + WSL2 quirk silently drops the bind-mounted
    config, so SearXNG starts with the default settings (JSON output OFF).
    """
    if not await _container_running():
        return ActionResult(
            success=False,
            output=f"Container {_CONTAINER!r} is not running — install it first.",
        )

    # Preserve the existing secret_key (live one inside the container, falling
    # back to the host file, finally a fresh key) so user sessions survive.
    secret = (
        await _container_secret_key(_CONTAINER)
        or await _host_secret_key((await _wsl_home() or "") + "/AgentChat/searxng/settings.yml")
        or secrets.token_hex(32)
    )
    content = _settings_yml(secret)

    ok, msg = await _apply_settings_into_container(_CONTAINER, content)
    if not ok:
        return ActionResult(success=False, output=msg or "repair failed")

    if await _wait_for_health():
        return ActionResult(
            success=True,
            output=f"SearXNG settings re-applied; JSON endpoint is responding at {_URL}.",
        )
    return ActionResult(
        success=False,
        output=(
            "Settings re-applied but the JSON endpoint did not respond in time. "
            "Check `docker logs agentchat-searxng`."
        ),
    )

