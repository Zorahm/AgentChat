"""WSL management API — status probe + install helpers for the onboarding wizard."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/wsl", tags=["wsl"])


# ── Models ────────────────────────────────────────────────────────────────


class WSLStatus(BaseModel):
    """Result of /api/wsl/status — what's present and what's missing."""

    wsl_installed: bool
    default_distro: str | None
    distro_running: bool
    node: str | None
    python: str | None
    npm: str | None
    docx: bool  # global npm `docx` package available


class InstallResult(BaseModel):
    """Result of an install operation."""

    success: bool
    output: str


# ── Subprocess helpers ────────────────────────────────────────────────────


async def _run(args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run a command in a thread and return (returncode, stdout, stderr)."""
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            args,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except OSError as exc:
        return 1, "", str(exc)
    # wsl.exe writes Unicode in UTF-16LE on some Windows builds; try utf-8 then utf-16.
    raw_out = result.stdout
    raw_err = result.stderr
    out = _decode_loose(raw_out)
    err = _decode_loose(raw_err)
    return result.returncode, out, err


def _decode_loose(data: bytes) -> str:
    """Best-effort bytes → str. WSL CLI sometimes emits UTF-16LE."""
    if not data:
        return ""
    try:
        s = data.decode("utf-8")
        # Heuristic: WSL UTF-16 output has lots of NUL bytes between chars.
        if "\x00" in s:
            raise UnicodeDecodeError("utf-8", data, 0, 1, "looks like utf-16")
        return s
    except UnicodeDecodeError:
        try:
            return data.decode("utf-16-le").replace("\x00", "")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")


async def _wsl_default_distro() -> str | None:
    """Parse `wsl -l -q` for the default distro name."""
    code, out, _ = await _run(["wsl.exe", "-l", "-q"], timeout=10)
    if code != 0:
        return None
    for line in out.splitlines():
        name = line.strip()
        if name:
            return name
    return None


async def _wsl_which(binary: str) -> str | None:
    """Resolve a binary inside the default WSL distro. Returns version string or None."""
    code, out, _ = await _run(
        ["wsl.exe", "--", "bash", "-lc", f"command -v {binary} >/dev/null 2>&1 && {binary} --version | head -n1"],
        timeout=15,
    )
    if code != 0:
        return None
    line = out.strip()
    return line or None


async def _has_global_npm_pkg(pkg: str) -> bool:
    """Check if `pkg` is installed as a global npm package inside WSL."""
    code, out, _ = await _run(
        ["wsl.exe", "--", "bash", "-lc", f"npm ls -g --depth=0 {pkg} 2>/dev/null | grep -q ' {pkg}@'"],
        timeout=20,
    )
    return code == 0


# ── Routes ────────────────────────────────────────────────────────────────


@router.get("/status", response_model=WSLStatus)
async def status() -> WSLStatus:
    """Probe WSL and required tooling state."""
    wsl_installed = shutil.which("wsl") is not None
    if not wsl_installed:
        return WSLStatus(
            wsl_installed=False,
            default_distro=None,
            distro_running=False,
            node=None,
            python=None,
            npm=None,
            docx=False,
        )

    distro = await _wsl_default_distro()
    distro_running = False
    node = python = npm = None
    docx = False

    if distro:
        # If `wsl bash` exits 0, the distro is reachable.
        code, _, _ = await _run(
            ["wsl.exe", "--", "bash", "-lc", "true"], timeout=10
        )
        distro_running = code == 0

        if distro_running:
            node = await _wsl_which("node")
            python = await _wsl_which("python3")
            npm = await _wsl_which("npm")
            if npm:
                docx = await _has_global_npm_pkg("docx")

    return WSLStatus(
        wsl_installed=wsl_installed,
        default_distro=distro,
        distro_running=distro_running,
        node=node,
        python=python,
        npm=npm,
        docx=docx,
    )


@router.post("/install-distro", response_model=InstallResult)
async def install_distro() -> InstallResult:
    """Launch `wsl --install -d Ubuntu` in a UAC-elevated PowerShell window.

    Returns immediately; the actual install happens in a separate elevated
    process and may take several minutes. Caller should poll /status.
    """
    # Start-Process -Verb RunAs triggers the UAC prompt.
    ps_cmd = "Start-Process -Verb RunAs -FilePath 'wsl.exe' -ArgumentList '--install','-d','Ubuntu'"
    code, out, err = await _run(
        ["powershell.exe", "-NoProfile", "-Command", ps_cmd], timeout=30
    )
    if code != 0:
        return InstallResult(success=False, output=err or out or "PowerShell exited with non-zero status")
    return InstallResult(
        success=True,
        output="Запущен установщик WSL. Дождитесь окончания установки и первого входа в дистрибутив.",
    )


@router.post("/install-deps", response_model=InstallResult)
async def install_deps() -> InstallResult:
    """Install Node, Python, and the `docx` npm package inside the default distro.

    Runs as root via `wsl --user root` to avoid the sudo-password prompt
    that would block a non-interactive subprocess.
    """
    script = (
        "set -e; "
        "export DEBIAN_FRONTEND=noninteractive; "
        "apt-get update; "
        "apt-get install -y nodejs npm python3 python3-pip; "
        "npm install -g docx"
    )
    code, out, err = await _run(
        ["wsl.exe", "--user", "root", "--", "bash", "-lc", script],
        timeout=600,
    )
    output = (out or "").strip()
    if err and err.strip():
        output = f"{output}\n[stderr]\n{err.strip()}".strip()
    if code != 0:
        return InstallResult(success=False, output=output or f"exit code {code}")
    return InstallResult(success=True, output=output or "OK")


@router.post("/install-docx", response_model=InstallResult)
async def install_docx() -> InstallResult:
    """Install just the `docx` npm package globally (faster path if Node already present)."""
    code, out, err = await _run(
        ["wsl.exe", "--user", "root", "--", "bash", "-lc", "npm install -g docx"],
        timeout=180,
    )
    output = (out or "").strip()
    if err and err.strip():
        output = f"{output}\n[stderr]\n{err.strip()}".strip()
    if code != 0:
        return InstallResult(success=False, output=output or f"exit code {code}")
    return InstallResult(success=True, output=output or "OK")
