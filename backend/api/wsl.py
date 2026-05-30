"""WSL management API — status probe + install helpers for the onboarding wizard."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from agent.wsl_exec import decode_loose

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/wsl", tags=["wsl"])

# Suppress the Windows console flash for wsl/probe subprocesses.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# In-process background install task — single concurrent install at most.
# install-deps used to block the HTTP request for 5–30 minutes, leaving the
# frontend stuck on a "Installing..." spinner with no visible activity (uvicorn's access
# log only fires on response). Moving it off the request thread fixes both.
_install_task: asyncio.Task[None] | None = None
_install_log: list[str] = []
_install_error: str | None = None

# Background distro-install + user-provision task (separate from install-deps).
_distro_task: asyncio.Task[None] | None = None
_distro_log: list[str] = []
_distro_error: str | None = None
_distro_done: bool = False

# Linux usernames: start with a letter/underscore, then letters/digits/_/- (max 32).
_USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


# ── Models ────────────────────────────────────────────────────────────────


class WSLStatus(BaseModel):
    """Result of /api/wsl/status — what's present and what's missing."""

    wsl_installed: bool
    default_distro: str | None
    distro_running: bool
    node: str | None
    python: str | None
    npm: str | None
    pandoc: str | None  # pandoc version string if installed in WSL
    libreoffice: str | None  # libreoffice version string if installed
    poppler: bool  # pdftotext (poppler-utils) is available
    docx: bool  # global npm `docx` package available
    dns_ok: bool  # hostname resolution works inside the distro
    powershell_available: bool
    # Resolved shell the next chat will use: "wsl" or "powershell".
    active_shell: str
    # Raw preference from settings ("auto" | "wsl" | "powershell").
    shell_preference: str


class InstallResult(BaseModel):
    """Result of an install operation."""

    success: bool
    output: str


# ── Subprocess helpers ────────────────────────────────────────────────────


async def _run(
    args: list[str], timeout: int = 30, env: dict[str, str] | None = None
) -> tuple[int, str, str]:
    """Run a command in a thread and return (returncode, stdout, stderr).

    When ``env`` is given it REPLACES the process environment, so callers must
    merge in ``os.environ`` themselves (used to forward credentials into WSL
    via WSLENV without putting them on the command line).
    """
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
    # wsl.exe writes Unicode in UTF-16LE on some Windows builds; try utf-8 then utf-16.
    raw_out = result.stdout
    raw_err = result.stderr
    out = decode_loose(raw_out)
    err = decode_loose(raw_err)
    return result.returncode, out, err


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


async def _wsl_has(binary: str) -> bool:
    """Check if a binary exists inside WSL (no version probe)."""
    code, _, _ = await _run(
        ["wsl.exe", "--", "bash", "-lc", f"command -v {binary} >/dev/null 2>&1"],
        timeout=10,
    )
    return code == 0


async def _has_global_npm_pkg(pkg: str) -> bool:
    """Check if `pkg` is installed as a global npm package inside WSL."""
    code, out, _ = await _run(
        ["wsl.exe", "--", "bash", "-lc", f"npm ls -g --depth=0 {pkg} 2>/dev/null | grep -q ' {pkg}@'"],
        timeout=20,
    )
    return code == 0


async def _wsl_dns_works() -> bool:
    """Resolve a well-known host inside WSL. Returns True only if DNS works.

    `getent hosts` uses NSS and respects /etc/resolv.conf — exactly the path
    that pip/apt/npm take when they hit a hostname. Falls back to dig/host on
    distros where getent is unusual."""
    code, _, _ = await _run(
        ["wsl.exe", "--", "bash", "-lc",
         "getent hosts deb.debian.org >/dev/null 2>&1 || "
         "getent hosts pypi.org >/dev/null 2>&1"],
        timeout=10,
    )
    return code == 0


# Fix script: applied as root.
# Steps:
#   1. /etc/wsl.conf — tell WSL to stop generating /etc/resolv.conf each boot.
#   2. Remove existing resolv.conf (symlink or stub) so our file isn't shadowed.
#   3. Write Cloudflare + Google nameservers — public, reliable, no auth.
#   4. chattr +i to lock it (best-effort; ext4 only — ignored on wslfs).
# After this, the caller must run `wsl --shutdown` from Windows so the new
# /etc/wsl.conf takes effect on next boot.
_DNS_FIX_SCRIPT = r"""
set -e
mkdir -p /etc
if ! grep -q '^\[network\]' /etc/wsl.conf 2>/dev/null; then
  printf '\n[network]\ngenerateResolvConf = false\n' >> /etc/wsl.conf
elif ! grep -q 'generateResolvConf' /etc/wsl.conf; then
  sed -i '/^\[network\]/a generateResolvConf = false' /etc/wsl.conf
fi
chattr -i /etc/resolv.conf 2>/dev/null || true
rm -f /etc/resolv.conf
cat > /etc/resolv.conf <<'EOF'
nameserver 1.1.1.1
nameserver 8.8.8.8
nameserver 1.0.0.1
EOF
chattr +i /etc/resolv.conf 2>/dev/null || true
echo OK
"""


async def _apply_dns_fix() -> tuple[bool, str]:
    """Write resolv.conf + wsl.conf inside WSL, then shutdown so next launch
    picks up the new generateResolvConf setting. Returns (success, log)."""
    code, out, err = await _run(
        ["wsl.exe", "--user", "root", "--", "bash", "-lc", _DNS_FIX_SCRIPT],
        timeout=30,
    )
    log = "\n".join(s for s in [out.strip(), err.strip()] if s)
    if code != 0:
        return False, log or f"dns fix script exit {code}"

    shut_code, shut_out, shut_err = await _run(
        ["wsl.exe", "--shutdown"], timeout=20,
    )
    shut_log = "\n".join(s for s in [shut_out.strip(), shut_err.strip()] if s)
    if shut_code != 0:
        return False, f"{log}\n[shutdown] {shut_log}".strip()
    return True, f"{log}\n[shutdown] {shut_log or 'OK'}".strip()


# ── Distro install + user provisioning ─────────────────────────────────────


def _ps_quote(text: str) -> str:
    """Single-quote a string for a PowerShell argument (doubles inner quotes)."""
    return "'" + text.replace("'", "''") + "'"


async def _launch_wsl_install() -> tuple[int, str, str]:
    """Run `wsl --install -d Ubuntu --no-launch` in a UAC-elevated process and
    wait for it, returning its real exit code.

    ``--no-launch`` registers the distro WITHOUT running Ubuntu's interactive
    first-boot user setup — we create the Linux user ourselves afterwards.
    ``-Wait -PassThru`` lets us propagate the installer's exit code (via
    ``exit $p.ExitCode``) so the caller can react to a real failure (→ DISM)
    instead of waiting out a registration timeout. The download runs inside the
    elevated process, hence the long timeout.
    """
    ps_cmd = (
        "$p = Start-Process -Verb RunAs -Wait -PassThru -FilePath 'wsl.exe' "
        "-ArgumentList '--install','-d','Ubuntu','--no-launch'; exit $p.ExitCode"
    )
    return await _run(["powershell.exe", "-NoProfile", "-Command", ps_cmd], timeout=900)


async def _do_enable_features(emit: Any) -> bool:
    """Enable the two Windows optional features WSL needs, via elevated DISM.

    Run when `wsl --install` errors or the distro never registers. Both DISM
    commands run inside ONE elevated PowerShell (single UAC prompt), and we
    -Wait for them so we know whether they completed. A reboot is usually
    required afterwards before the distro can register.
    """
    inner = (
        "dism.exe /online /enable-feature "
        "/featurename:Microsoft-Windows-Subsystem-Linux /all /norestart; "
        "dism.exe /online /enable-feature "
        "/featurename:VirtualMachinePlatform /all /norestart"
    )
    ps_cmd = (
        "Start-Process -Verb RunAs -Wait -FilePath 'powershell.exe' "
        "-ArgumentList '-NoProfile','-NoLogo','-Command'," + _ps_quote(inner)
    )
    code, out, err = await _run(
        ["powershell.exe", "-NoProfile", "-Command", ps_cmd], timeout=300
    )
    tail = "\n".join(s for s in [(out or "").strip(), (err or "").strip()] if s)
    if tail:
        emit(tail[-1500:])
    if code != 0:
        emit("DISM step did not complete (UAC declined or error).")
        return False
    emit("Windows features enabled via DISM.")
    return True


async def _wait_registered(timeout: int = 600) -> bool:
    """Poll `wsl -l -q` until an Ubuntu distro appears (registration done)."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        await asyncio.sleep(5)
        code, out, _ = await _run(["wsl.exe", "-l", "-q"], timeout=10)
        if code == 0 and any(
            "ubuntu" in line.strip().lower() for line in out.splitlines() if line.strip()
        ):
            return True
    return False


# Provision script — runs as root inside the freshly registered distro.
# Reads the username/password from env (forwarded via WSLENV) so neither ever
# appears on the command line. Creates the user, sets the password, grants
# passwordless sudo, and pins it as the distro's default user in /etc/wsl.conf.
_PROVISION_SCRIPT = r"""
set -e
U="$WSL_NEW_USER"
if [ -z "$U" ]; then echo "no username"; exit 2; fi
if ! id "$U" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$U"
fi
printf '%s:%s\n' "$U" "$WSL_NEW_PASS" | chpasswd
usermod -aG sudo "$U"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$U" > "/etc/sudoers.d/90-agentchat"
chmod 0440 /etc/sudoers.d/90-agentchat
if grep -q '^\[user\]' /etc/wsl.conf 2>/dev/null; then
  if grep -q '^default=' /etc/wsl.conf; then
    sed -i "s/^default=.*/default=$U/" /etc/wsl.conf
  else
    sed -i "/^\[user\]/a default=$U" /etc/wsl.conf
  fi
else
  printf '\n[user]\ndefault=%s\n' "$U" >> /etc/wsl.conf
fi
echo OK
"""


async def _provision_user(username: str, password: str) -> tuple[bool, str]:
    """Create the Linux user as root, then shut WSL down so the new default
    user takes effect on next launch. Credentials are passed via WSLENV."""
    if not _USERNAME_RE.match(username):
        return False, f"invalid username {username!r} (use a-z, 0-9, _ or -, start with a letter)"
    if not password or "\n" in password:
        return False, "invalid password"

    existing_wslenv = os.environ.get("WSLENV", "")
    forward = "WSL_NEW_USER/u:WSL_NEW_PASS/u"
    env = {
        **os.environ,
        "WSL_NEW_USER": username,
        "WSL_NEW_PASS": password,
        "WSLENV": f"{existing_wslenv}:{forward}" if existing_wslenv else forward,
    }
    code, out, err = await _run(
        ["wsl.exe", "-d", "Ubuntu", "--user", "root", "--", "bash", "-lc", _PROVISION_SCRIPT],
        timeout=120,
        env=env,
    )
    log = "\n".join(s for s in [(out or "").strip(), (err or "").strip()] if s)
    if code != 0:
        return False, log or f"provision script exit {code}"
    # Shut down so /etc/wsl.conf default user applies on the next launch.
    await _run(["wsl.exe", "--shutdown"], timeout=20)
    return True, log or "OK"


async def _run_install_distro(username: str, password: str) -> None:
    """Background worker: install Ubuntu, fall back to DISM on failure, then
    create the Linux user. Progress is written to module-level state."""
    global _distro_error, _distro_done
    _distro_error = None
    _distro_done = False
    _distro_log.clear()

    def emit(line: str) -> None:
        logger.info("install-distro: %s", line)
        _distro_log.append(line)

    try:
        emit("Launching the WSL + Ubuntu installer (a UAC prompt may appear)…")
        code, out, err = await _launch_wsl_install()
        if code != 0:
            launch_msg = (err or out or "").strip()
            if launch_msg:
                emit(launch_msg)
            emit("Installer launch failed — enabling Windows features via DISM…")
            await _do_enable_features(emit)
            _distro_error = (
                "Windows features for WSL were just enabled. Please RESTART Windows, "
                "then run the WSL setup again."
            )
            return

        emit("Waiting for the Ubuntu distro to register (first download can take several minutes)…")
        if not await _wait_registered(timeout=600):
            emit("Distro did not register in time — enabling Windows features via DISM as a fallback…")
            await _do_enable_features(emit)
            _distro_error = (
                "Could not register the Ubuntu distro. Windows features were enabled — "
                "RESTART Windows and try again."
            )
            return

        emit("Distro registered. Creating the Linux user…")
        ok, log = await _provision_user(username, password)
        if log:
            emit(log)
        if not ok:
            _distro_error = "Failed to create the Linux user — see the log above."
            return
        emit("✓ WSL is ready.")
        _distro_done = True
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("install-distro background task failed")
        _distro_error = f"Unexpected error: {exc}"


# ── Routes ────────────────────────────────────────────────────────────────


@router.get("/status", response_model=WSLStatus)
async def status(request: Request) -> WSLStatus:
    """Probe WSL and required tooling state, plus PowerShell availability and
    the resolved active shell for the next chat."""
    from main import resolve_active_shell  # avoid circular import at module load

    settings_store = request.app.state.settings_store
    preference = settings_store.shell_preference
    ps_available = shutil.which("powershell") is not None or shutil.which("pwsh") is not None
    wsl_installed = shutil.which("wsl") is not None

    if not wsl_installed:
        return WSLStatus(
            wsl_installed=False,
            default_distro=None,
            distro_running=False,
            node=None,
            python=None,
            npm=None,
            pandoc=None,
            libreoffice=None,
            poppler=False,
            docx=False,
            dns_ok=False,
            powershell_available=ps_available,
            active_shell=resolve_active_shell(preference),
            shell_preference=preference,
        )

    distro = await _wsl_default_distro()
    distro_running = False
    node = python = npm = pandoc = libreoffice = None
    poppler = False
    docx = False
    dns_ok = False

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
            pandoc = await _wsl_which("pandoc")
            libreoffice = await _wsl_which("libreoffice")
            # poppler-utils ships `pdftotext`; that's the marker we probe for.
            poppler = await _wsl_has("pdftotext")
            if npm:
                docx = await _has_global_npm_pkg("docx")
            dns_ok = await _wsl_dns_works()

    return WSLStatus(
        wsl_installed=wsl_installed,
        default_distro=distro,
        distro_running=distro_running,
        node=node,
        python=python,
        npm=npm,
        pandoc=pandoc,
        libreoffice=libreoffice,
        poppler=poppler,
        docx=docx,
        dns_ok=dns_ok,
        powershell_available=ps_available,
        active_shell=resolve_active_shell(preference),
        shell_preference=preference,
    )


class InstallDistroRequest(BaseModel):
    """Credentials for the Linux user AgentChat creates during install."""

    username: str
    password: str


class InstallDistroStatus(BaseModel):
    """Snapshot of the background distro-install/provision task."""

    running: bool
    log: str
    error: str | None
    done: bool


@router.post("/install-distro", response_model=InstallResult)
async def install_distro(body: InstallDistroRequest) -> InstallResult:
    """Install Ubuntu and provision the Linux user, in the background.

    Validates the requested username up front, then kicks off a worker that
    launches `wsl --install -d Ubuntu --no-launch`, falls back to enabling the
    Windows features via DISM if that errors, and finally creates the Linux
    user (no interactive first-boot prompt). Caller polls
    /wsl/install-distro/status.
    """
    global _distro_task
    username = body.username.strip().lower()
    if not _USERNAME_RE.match(username):
        return InstallResult(
            success=False,
            output="Invalid username — use a-z, 0-9, _ or -, starting with a letter.",
        )
    if not body.password or "\n" in body.password:
        return InstallResult(success=False, output="Password must be non-empty and single-line.")

    if _distro_task and not _distro_task.done():
        return InstallResult(
            success=True, output="Install is already running — watch the progress here."
        )
    logger.info("install-distro: scheduling background task")
    _distro_task = asyncio.create_task(_run_install_distro(username, body.password))
    return InstallResult(
        success=True,
        output="WSL install started in the background. This can take several minutes.",
    )


@router.get("/install-distro/status", response_model=InstallDistroStatus)
async def install_distro_status() -> InstallDistroStatus:
    """Return the current distro-install task's log, error, and running state."""
    running = _distro_task is not None and not _distro_task.done()
    return InstallDistroStatus(
        running=running,
        log="\n".join(_distro_log),
        error=_distro_error,
        done=_distro_done,
    )


@router.post("/enable-features", response_model=InstallResult)
async def enable_features() -> InstallResult:
    """Enable the WSL + Virtual Machine Platform Windows features via elevated
    DISM. Exposed for a manual retry; the install flow also calls this on error.
    A Windows restart is normally required afterwards."""
    log: list[str] = []
    ok = await _do_enable_features(log.append)
    output = "\n".join(log) or ("OK" if ok else "DISM failed")
    if ok:
        output += "\n\nA Windows RESTART is required before WSL can be installed."
    return InstallResult(success=ok, output=output)


class InstallDepsStatus(BaseModel):
    """Snapshot of the current background install-deps task."""

    running: bool
    log: str
    error: str | None


async def _run_install_deps() -> None:
    """Background worker. Writes progress to module-level state."""
    global _install_error
    _install_error = None
    _install_log.clear()

    def emit(line: str) -> None:
        logger.info("install-deps: %s", line)
        _install_log.append(line)

    try:
        emit("Starting: checking DNS inside WSL...")
        if not await _wsl_dns_works():
            emit("DNS broken — applying fix (resolv.conf + wsl.conf, then wsl --shutdown).")
            ok, log = await _apply_dns_fix()
            if log:
                emit(log)
            if not ok:
                _install_error = "DNS fix failed — apt won't be able to resolve hosts."
                return
            emit("DNS fixed.")

        emit("Running apt update + installing Node, Python, pandoc, LibreOffice, poppler-utils. This takes 5-10 minutes.")
        # `--no-install-recommends` keeps footprint reasonable — without it
        # pandoc pulls texlive (several hundred MB) and libreoffice pulls
        # fonts and clipart that aren't needed for headless conversion.
        script = (
            "set -e; "
            "export DEBIAN_FRONTEND=noninteractive; "
            "apt-get update; "
            "apt-get install -y nodejs npm python3 python3-pip python3-venv; "
            "apt-get install -y --no-install-recommends pandoc; "
            "apt-get install -y --no-install-recommends libreoffice; "
            "apt-get install -y poppler-utils; "
            "npm install -g docx"
        )
        code, out, err = await _run(
            ["wsl.exe", "--user", "root", "--", "bash", "-lc", script],
            timeout=1800,
        )
        tail = "\n".join(filter(None, [(out or "").strip(), (err or "").strip()]))
        if tail:
            emit(tail[-2000:])  # cap to keep memory bounded
        if code != 0:
            _install_error = f"apt returned exit code {code} — see log for details."
            return
        emit("✓ Done. All libraries installed.")
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("install-deps background task failed")
        _install_error = f"Unexpected error: {exc}"


@router.post("/install-deps", response_model=InstallResult)
async def install_deps() -> InstallResult:
    """Kick off the install in the background and return immediately.

    The caller polls /wsl/install-deps/status (or /wsl/status, watching for
    libreoffice/poppler/docx flips) to know when it's done.

    Returning fast is the load-bearing change here. The previous version
    blocked the HTTP request for 5–30 minutes; uvicorn doesn't log until
    a response is sent, so the request appeared "stuck" from the UI side
    with no visible activity.
    """
    global _install_task
    if _install_task and not _install_task.done():
        return InstallResult(
            success=True,
            output="Install is already running — watch the progress in this window.",
        )
    logger.info("install-deps: scheduling background task")
    _install_task = asyncio.create_task(_run_install_deps())
    return InstallResult(
        success=True,
        output="Install started in the background. This takes 5-10 minutes.",
    )


@router.get("/install-deps/status", response_model=InstallDepsStatus)
async def install_deps_status() -> InstallDepsStatus:
    """Return the current install task's log and running state."""
    running = _install_task is not None and not _install_task.done()
    return InstallDepsStatus(
        running=running,
        log="\n".join(_install_log),
        error=_install_error,
    )


@router.post("/fix-dns", response_model=InstallResult)
async def fix_dns() -> InstallResult:
    """Repair WSL DNS by pinning Cloudflare + Google nameservers.

    Triggers `wsl --shutdown` at the end — the next command into WSL will
    spin up a fresh VM with the new /etc/wsl.conf settings honored.
    """
    ok, log = await _apply_dns_fix()
    return InstallResult(success=ok, output=log or ("OK" if ok else "fix failed"))


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
