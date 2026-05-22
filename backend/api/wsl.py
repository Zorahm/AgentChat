"""WSL management API — status probe + install helpers for the onboarding wizard."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/wsl", tags=["wsl"])

# Suppress the Windows console flash for wsl/probe subprocesses.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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


async def _run(args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run a command in a thread and return (returncode, stdout, stderr)."""
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            args,
            capture_output=True,
            timeout=timeout,
            creationflags=_NO_WINDOW,
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
            docx=False,
            dns_ok=False,
            powershell_available=ps_available,
            active_shell=resolve_active_shell(preference),
            shell_preference=preference,
        )

    distro = await _wsl_default_distro()
    distro_running = False
    node = python = npm = pandoc = None
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
        docx=docx,
        dns_ok=dns_ok,
        powershell_available=ps_available,
        active_shell=resolve_active_shell(preference),
        shell_preference=preference,
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
    """Install Node, Python, pandoc, and the `docx` npm package inside the default distro.

    Runs as root via `wsl --user root` to avoid the sudo-password prompt
    that would block a non-interactive subprocess. If DNS resolution is
    broken inside WSL, apply the fix first — otherwise `apt-get update`
    would fail on host lookup before installing anything.
    """
    preflight_log = ""
    if not await _wsl_dns_works():
        ok, log = await _apply_dns_fix()
        preflight_log = f"[dns fix]\n{log}\n"
        if not ok:
            return InstallResult(
                success=False,
                output=preflight_log + "DNS fix failed — apt would not be able to resolve hosts.",
            )

    # `--no-install-recommends` on pandoc keeps the apt footprint reasonable —
    # without it apt pulls in texlive and several hundred MB of LaTeX runtime
    # that we don't need for text extraction.
    script = (
        "set -e; "
        "export DEBIAN_FRONTEND=noninteractive; "
        "apt-get update; "
        "apt-get install -y nodejs npm python3 python3-pip; "
        "apt-get install -y --no-install-recommends pandoc; "
        "npm install -g docx"
    )
    code, out, err = await _run(
        ["wsl.exe", "--user", "root", "--", "bash", "-lc", script],
        timeout=600,
    )
    output = (out or "").strip()
    if err and err.strip():
        output = f"{output}\n[stderr]\n{err.strip()}".strip()
    output = preflight_log + output
    if code != 0:
        return InstallResult(success=False, output=output or f"exit code {code}")
    return InstallResult(success=True, output=output or "OK")


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
