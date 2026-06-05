"""Windows-native dependency check + winget install for the onboarding wizard.

The PowerShell counterpart to ``api/wsl.py``. When the user picks the
PowerShell shell (i.e. runs the agent on Windows directly rather than inside
WSL), this module probes for the same office-format tooling and installs
whatever is missing via ``winget`` in a single elevated batch.

Windows-only: off Windows every endpoint returns a no-op shaped response so the
frontend can simply hide the panel (``is_windows: false``).
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from agent.wsl_exec import decode_loose

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/win", tags=["win"])

# Suppress the Windows console flash for probe subprocesses.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_IS_WINDOWS = platform.system() == "Windows"

# In-process background install task — single concurrent install at most
# (mirrors the wsl.py pattern). The elevated installer streams into a shared
# log file; this task tails it and exposes progress via /install-deps/status.
_install_task: asyncio.Task[None] | None = None
_install_log: list[str] = []  # coarse status lines emitted from here
_install_filelog: str = ""  # cleaned tail of the elevated installer's log file
_install_error: str | None = None

# winget package id + display name keyed by the status field it satisfies.
# ``docx`` is special-cased (npm), so it is not listed here.
_PACKAGES: dict[str, tuple[str, str]] = {
    "node": ("OpenJS.NodeJS.LTS", "Node.js"),
    "python": ("Python.Python.3.12", "Python 3"),
    "pandoc": ("JohnMacFarlane.Pandoc", "pandoc"),
    "libreoffice": ("TheDocumentFoundation.LibreOffice", "LibreOffice"),
    "poppler": ("oschwartz10612.Poppler", "poppler"),
}

# Shared IPC log file between the (elevated) installer and this process.
_LOG_FILE = Path(tempfile.gettempdir()) / "agentchat_windeps.log"
_DONE_MARKER = "=== AGENTCHAT_DONE"
# Block-element glyphs winget uses for its progress bar; stripped from the log.
_BLOCK_RE = re.compile(r"[▀-▟﻿]")


# ── Models ────────────────────────────────────────────────────────────────


class WinDepsStatus(BaseModel):
    """Result of /api/win/status — what's present on Windows and what's missing."""

    is_windows: bool
    winget: bool  # winget.exe is on PATH (needed to install anything)
    node: str | None  # version string if installed
    python: str | None
    pandoc: str | None
    libreoffice: str | None
    poppler: bool  # pdftotext (poppler) is on PATH
    docx: bool  # global npm `docx` package available


class InstallResult(BaseModel):
    """Result of an install operation."""

    success: bool
    output: str


class WinInstallStatus(BaseModel):
    """Snapshot of the background install task."""

    running: bool
    log: str
    error: str | None


# ── Subprocess + probe helpers ─────────────────────────────────────────────


async def _run(
    args: list[str], timeout: int = 30, env: dict[str, str] | None = None
) -> tuple[int, str, str]:
    """Run a command in a thread and return (returncode, stdout, stderr)."""
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            args,
            capture_output=True,
            timeout=timeout,
            creationflags=_NO_WINDOW,
            env=env,
        )
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except OSError as exc:
        return 1, "", str(exc)
    return result.returncode, decode_loose(result.stdout), decode_loose(result.stderr)


async def _probe_version(exe: str, arg: str = "--version") -> str | None:
    """Return the first version line for ``exe`` on PATH, or None if absent.

    A non-zero exit covers the Windows "App Execution Alias" stub for Python:
    running the stub with an argument prints a Store hint to stderr and exits
    non-zero, so we correctly report it as not installed.
    """
    path = shutil.which(exe)
    if not path:
        return None
    code, out, err = await _run([path, arg], timeout=15)
    if code != 0:
        return None
    for line in (out or err).splitlines():
        text = line.strip()
        if text:
            return text
    return "installed"


def _find_soffice() -> str | None:
    """Locate LibreOffice's soffice.exe (it doesn't always land on PATH)."""
    found = shutil.which("soffice") or shutil.which("soffice.com")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")):
        if base:
            candidate = Path(base) / "LibreOffice" / "program" / "soffice.exe"
            if candidate.exists():
                return str(candidate)
    return None


async def _probe_libreoffice() -> str | None:
    """Version string for LibreOffice, or None if not installed."""
    exe = _find_soffice()
    if not exe:
        return None
    code, out, err = await _run([exe, "--version"], timeout=20)
    if code == 0:
        for line in (out or err).splitlines():
            text = line.strip()
            if text:
                return text
    return "installed"  # present, but the headless version probe was quiet


async def _has_docx() -> bool:
    """Check if the global npm `docx` package is installed.

    npm ships as ``npm.cmd`` on Windows, which CreateProcess won't launch
    directly — go through ``cmd /c`` so PATH resolution and the .cmd shim work.
    """
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        return False
    code, out, _ = await _run(["cmd", "/c", "npm", "ls", "-g", "docx", "--depth=0"], timeout=30)
    return code == 0 and "docx@" in out


async def _probe_all() -> WinDepsStatus:
    """Probe every dependency. Caller guarantees we're on Windows."""
    return WinDepsStatus(
        is_windows=True,
        winget=shutil.which("winget") is not None,
        node=await _probe_version("node"),
        python=await _probe_version("python"),
        pandoc=await _probe_version("pandoc"),
        libreoffice=await _probe_libreoffice(),
        poppler=shutil.which("pdftotext") is not None,
        docx=await _has_docx(),
    )


# ── Elevated install ───────────────────────────────────────────────────────


def _ps_quote(text: str) -> str:
    """Single-quote a string for a PowerShell argument (doubles inner quotes)."""
    return "'" + text.replace("'", "''") + "'"


def _build_install_script(missing_pkgs: list[str], install_docx: bool) -> str:
    """Build the .ps1 the elevated process runs.

    Each step appends to ``_LOG_FILE`` so this process can tail progress. The
    final line writes a done marker with the worst winget exit code so we can
    tell success from failure once the elevated process exits.
    """
    lines = [
        "$ErrorActionPreference = 'Continue'",
        "$ProgressPreference = 'SilentlyContinue'",
        f"$log = {_ps_quote(str(_LOG_FILE))}",
        "'' | Out-File -FilePath $log -Encoding utf8",  # truncate any stale log
        "function Log($m){ $m | Out-File -FilePath $log -Append -Encoding utf8 }",
        "$rc = 0",
    ]
    for key in missing_pkgs:
        pkg_id, name = _PACKAGES[key]
        lines.append(f"Log '=== Installing {name} ({pkg_id}) ==='")
        lines.append(
            f"winget install --id {pkg_id} -e --source winget "
            "--accept-source-agreements --accept-package-agreements "
            "--disable-interactivity 2>&1 | Out-File -FilePath $log -Append -Encoding utf8"
        )
        lines.append("if ($LASTEXITCODE -ne 0) { $rc = $LASTEXITCODE }")
    if install_docx:
        # node/npm may have just been installed; refresh PATH from the registry
        # so this same elevated session can find npm.
        lines.append("Log '=== Refreshing PATH ==='")
        lines.append(
            "$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + "
            "[System.Environment]::GetEnvironmentVariable('Path','User')"
        )
        lines.append("Log '=== Installing docx (npm -g) ==='")
        lines.append(
            "cmd /c npm install -g docx 2>&1 | Out-File -FilePath $log -Append -Encoding utf8"
        )
        lines.append("if ($LASTEXITCODE -ne 0) { $rc = $LASTEXITCODE }")
    lines.append(f'Log "{_DONE_MARKER} $rc ==="')
    return "\r\n".join(lines)


def _clean_log(raw: str) -> str:
    """Strip winget's progress-bar noise from the raw log file."""
    cleaned: list[str] = []
    for line in raw.splitlines():
        text = _BLOCK_RE.sub("", line).strip()
        if not text or re.fullmatch(r"\d{1,3}%", text):
            continue
        if not cleaned or cleaned[-1] != text:  # drop consecutive duplicates
            cleaned.append(text)
    return "\n".join(cleaned)


def _parse_done_rc(raw: str) -> int:
    """Return the exit code reported by the installer's done marker."""
    match = re.search(r"AGENTCHAT_DONE\s+(-?\d+)", raw)
    return int(match.group(1)) if match else 0


async def _run_install_win_deps(missing_pkgs: list[str], install_docx: bool) -> None:
    """Background worker: launch an elevated winget batch and tail its log."""
    global _install_error, _install_filelog
    _install_error = None
    _install_filelog = ""
    _install_log.clear()

    def emit(line: str) -> None:
        logger.info("win-install: %s", line)
        _install_log.append(line)

    script_path: str | None = None
    try:
        script = _build_install_script(missing_pkgs, install_docx)
        fd, script_path = tempfile.mkstemp(suffix=".ps1", prefix="agentchat_windeps_")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(script)

        emit("Requesting administrator approval (a UAC prompt may appear)…")
        launch = (
            "Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList "
            "'-NoProfile','-ExecutionPolicy','Bypass','-File'," + _ps_quote(script_path)
        )
        code, out, err = await _run(
            ["powershell.exe", "-NoProfile", "-Command", launch], timeout=60
        )
        if code != 0:
            msg = (err or out or "").strip()
            if "cancel" in msg.lower():
                _install_error = "Installation cancelled — administrator approval was declined."
            else:
                _install_error = msg or "Failed to start the elevated installer."
            return

        emit("Installer running. Downloading and installing packages — this can take several minutes…")
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            await asyncio.sleep(2)
            try:
                raw = _LOG_FILE.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            _install_filelog = _clean_log(raw)
            if _DONE_MARKER in raw:
                rc = _parse_done_rc(raw)
                if rc != 0:
                    _install_error = f"winget reported errors (exit {rc}). See the log above."
                else:
                    emit("✓ Done. Click Re-check (some tools are detected only after an app restart).")
                return
        _install_error = "Timed out waiting for the installer to finish."
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("win-install background task failed")
        _install_error = f"Unexpected error: {exc}"
    finally:
        if script_path:
            try:
                os.remove(script_path)
            except OSError:
                pass


# ── Routes ────────────────────────────────────────────────────────────────


@router.get("/status", response_model=WinDepsStatus)
async def status() -> WinDepsStatus:
    """Probe Windows-native office tooling. Off Windows: is_windows=False."""
    if not _IS_WINDOWS:
        return WinDepsStatus(
            is_windows=False,
            winget=False,
            node=None,
            python=None,
            pandoc=None,
            libreoffice=None,
            poppler=False,
            docx=False,
        )
    return await _probe_all()


@router.post("/install-deps", response_model=InstallResult)
async def install_deps() -> InstallResult:
    """Install whatever Windows-native deps are missing, via winget, in the background.

    Computes the missing set fresh, then kicks off one elevated PowerShell that
    runs ``winget install`` per package (single UAC prompt). Caller polls
    /win/install-deps/status.
    """
    global _install_task
    if not _IS_WINDOWS:
        return InstallResult(success=False, output="This installer is Windows-only.")
    if shutil.which("winget") is None:
        return InstallResult(
            success=False,
            output="winget isn't available. Install 'App Installer' from the Microsoft Store, then retry.",
        )
    if _install_task and not _install_task.done():
        return InstallResult(
            success=True, output="Install is already running — watch the progress here."
        )

    current = await _probe_all()
    missing_pkgs = [
        key
        for key in _PACKAGES
        if not getattr(current, key)  # node/python/pandoc/libreoffice falsy, poppler False
    ]
    install_docx = not current.docx
    if not missing_pkgs and not install_docx:
        return InstallResult(success=True, output="Everything is already installed.")

    logger.info("win-install: scheduling background task (missing=%s, docx=%s)", missing_pkgs, install_docx)
    _install_task = asyncio.create_task(_run_install_win_deps(missing_pkgs, install_docx))
    return InstallResult(
        success=True,
        output="Install started in the background. This can take several minutes.",
    )


@router.get("/install-deps/status", response_model=WinInstallStatus)
async def install_deps_status() -> WinInstallStatus:
    """Return the current install task's log, error, and running state."""
    running = _install_task is not None and not _install_task.done()
    parts = list(_install_log)
    if _install_filelog:
        parts.append(_install_filelog)
    return WinInstallStatus(running=running, log="\n".join(parts), error=_install_error)
