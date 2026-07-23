"""WSL management API — status probe + install helpers for the onboarding wizard."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from agent.exec_common import run_capture
from shell import resolve_active_shell

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/wsl", tags=["wsl"])


def _os_platform() -> str:
    """Coarse host OS for the UI: windows | darwin | linux."""
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"

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
    internet_ok: bool  # WSL can actually reach the internet (routing, not just DNS)
    mirrored_supported: bool  # Windows build + WSL version support mirrored networking
    mirrored_active: bool  # .wslconfig already has networkingMode=mirrored
    powershell_available: bool
    # Whether a zsh binary is on PATH (native Linux/macOS only). Lets the UI
    # offer the bash⇄zsh picker and flag a missing zsh.
    zsh_available: bool = False
    # Resolved shell the next chat will use: "wsl" | "powershell" | "posix" | "zsh".
    active_shell: str
    # Raw preference from settings ("auto" | "wsl" | "powershell" | "zsh").
    shell_preference: str
    # Host OS: "windows" | "linux" | "darwin". On non-Windows the UI hides the
    # WSL/PowerShell picker and offers the native bash⇄zsh one instead.
    os_platform: str
    # Native hosts only. Distro name from /etc/os-release and the package
    # manager we recognised; both None on Windows or an unrecognised distro.
    distro_name: str | None = None
    package_manager: str | None = None
    # A ready-to-run command installing whatever the checklist reports missing.
    # None when nothing is missing, or when we can't name packages for this
    # distro — the UI then just lists the missing tools.
    install_command: str | None = None


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
    return await run_capture(args, timeout=timeout, env=env)


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


async def _native_has_global_npm_pkg(pkg: str) -> bool:
    """Same probe as {@link _has_global_npm_pkg}, on the host's own shell."""
    code, _, _ = await _run(
        ["bash", "-lc", f"npm ls -g --depth=0 {pkg} 2>/dev/null | grep -q ' {pkg}@'"],
        timeout=20,
    )
    return code == 0


def _native_distro_name() -> str | None:
    """PRETTY_NAME from /etc/os-release, e.g. "Arch Linux"."""
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"') or None
    except OSError:
        pass
    return None


# How to install the tools the agent shells out to, per package manager. Only
# managers whose package names we can state confidently are listed; on anything
# else the UI falls back to naming the missing binaries and letting the user
# install them their own way.
_NATIVE_INSTALL_PREFIX: dict[str, str] = {
    "pacman": "sudo pacman -S --needed",
    "apt-get": "sudo apt-get install -y",
    "dnf": "sudo dnf install -y",
    "zypper": "sudo zypper install -y",
}

_NATIVE_PACKAGES: dict[str, dict[str, str]] = {
    "pacman": {
        "node": "nodejs", "npm": "npm", "python": "python",
        "pandoc": "pandoc-cli", "libreoffice": "libreoffice-fresh", "poppler": "poppler",
    },
    "apt-get": {
        "node": "nodejs", "npm": "npm", "python": "python3",
        "pandoc": "pandoc", "libreoffice": "libreoffice", "poppler": "poppler-utils",
    },
    "dnf": {
        "node": "nodejs", "npm": "npm", "python": "python3",
        "pandoc": "pandoc", "libreoffice": "libreoffice", "poppler": "poppler-utils",
    },
    "zypper": {
        "node": "nodejs", "npm": "npm", "python": "python3",
        "pandoc": "pandoc", "libreoffice": "libreoffice", "poppler": "poppler-tools",
    },
}


def _native_install_plan(missing: list[str]) -> tuple[str | None, str | None]:
    """Return (package manager, install command) for the missing tool keys.

    `docx` is a global npm package rather than a distro one, so it gets its own
    line appended. The command is a suggestion — package names drift between
    releases, and the user stays in charge of running it."""
    manager = next((m for m in _NATIVE_INSTALL_PREFIX if shutil.which(m)), None)
    if manager is None:
        return None, None

    lines: list[str] = []
    packages = sorted({_NATIVE_PACKAGES[manager][k] for k in missing if k in _NATIVE_PACKAGES[manager]})
    if packages:
        lines.append(f"{_NATIVE_INSTALL_PREFIX[manager]} {' '.join(packages)}")
    if "docx" in missing:
        lines.append("npm install -g docx")

    # Report the manager under its familiar name, not the binary we probed for.
    label = "apt" if manager == "apt-get" else manager
    return label, "\n".join(lines) or None


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


# ── VPN / network fix (mirrored networking) ────────────────────────────────
#
# When a VPN is up on Windows, WSL2's default NAT network often loses internet
# even when DNS resolves: the VPN owns the routing table and the WSL virtual
# switch isn't part of it. The fix is "mirrored" networking — WSL shares the
# host's interfaces directly, so the VPN's routes and DNS apply inside the
# distro too. It needs Windows 11 22H2+ (build 22621) and WSL app 2.0+.

# Keys written under [wsl2] in %USERPROFILE%\.wslconfig. dnsTunneling + autoProxy
# round out the VPN/corporate-proxy story; harmless when no VPN is present.
_MIRRORED_UPDATES = {
    "networkingMode": "mirrored",
    "dnsTunneling": "true",
    "autoProxy": "true",
}


def _windows_build() -> int:
    """Windows build number (e.g. 22631), or 0 if undetectable."""
    try:
        parts = platform.version().split(".")  # "10.0.22631"
        return int(parts[2]) if len(parts) >= 3 else 0
    except (ValueError, IndexError):
        return 0


async def _wsl_app_version() -> tuple[int, ...] | None:
    """Parse `wsl --version` for the WSL app version, e.g. (2, 0, 9, 0)."""
    code, out, _ = await _run(["wsl.exe", "--version"], timeout=10)
    if code != 0:
        return None
    match = re.search(r"(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?", out)
    if not match:
        return None
    return tuple(int(g) for g in match.groups() if g is not None)


def _mirrored_supported(build: int, wslver: tuple[int, ...] | None) -> bool:
    """True iff this host can use mirrored networking (Win11 22H2+, WSL 2.0+)."""
    return build >= 22621 and wslver is not None and wslver >= (2, 0, 0)


def _wslconfig_path() -> Path:
    """%USERPROFILE%\\.wslconfig — the Windows-side WSL2 config file."""
    return Path(os.path.expanduser("~")) / ".wslconfig"


def _read_wslconfig_mirrored() -> bool:
    """True iff .wslconfig already sets networkingMode=mirrored under [wsl2]."""
    try:
        text = _wslconfig_path().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    in_wsl2 = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            in_wsl2 = line.lower() == "[wsl2]"
            continue
        if in_wsl2 and "=" in line and not line.startswith("#"):
            key, _, val = line.partition("=")
            if key.strip().lower() == "networkingmode" and val.strip().lower() == "mirrored":
                return True
    return False


def _upsert_wslconfig(updates: dict[str, str]) -> Path:
    """Idempotently set ``updates`` keys under [wsl2] in .wslconfig.

    Existing keys are matched case-insensitively and overwritten; missing keys
    are appended to the section. Comments and other sections are left intact.
    Creates the file (and the section) when absent. Returns the path written.
    """
    path = _wslconfig_path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []

    canon = {k.lower(): (k, v) for k, v in updates.items()}  # lower -> (key, val)
    pending = set(canon)

    sect_start = next(
        (i for i, raw in enumerate(lines) if raw.strip().lower() == "[wsl2]"), -1
    )
    if sect_start == -1:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("[wsl2]")
        for low in canon:
            key, val = canon[low]
            lines.append(f"{key}={val}")
    else:
        sect_end = len(lines)
        for j in range(sect_start + 1, len(lines)):
            stripped = lines[j].strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                sect_end = j
                break
        for j in range(sect_start + 1, sect_end):
            stripped = lines[j].strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            low = stripped.split("=", 1)[0].strip().lower()
            if low in canon:
                key, val = canon[low]
                lines[j] = f"{key}={val}"
                pending.discard(low)
        insert_at = sect_end
        for low in list(pending):
            key, val = canon[low]
            lines.insert(insert_at, f"{key}={val}")
            insert_at += 1

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


async def _wsl_internet_works() -> bool:
    """True only if WSL can actually reach the internet, not merely resolve DNS.

    Tries an HTTPS fetch via curl/wget (covers DNS + routing + TLS), then falls
    back to a raw TCP connect to 1.1.1.1:443 via bash's /dev/tcp — that last
    probe bypasses DNS, so it isolates "routing is dead" (VPN) from "DNS is
    dead" (resolv.conf)."""
    script = (
        "if command -v curl >/dev/null 2>&1; then "
        "curl -sf --max-time 6 -o /dev/null https://pypi.org/simple/ && exit 0; fi; "
        "if command -v wget >/dev/null 2>&1; then "
        "wget -q --timeout=6 -O /dev/null https://pypi.org/simple/ && exit 0; fi; "
        "timeout 6 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && exit 0; "
        "exit 1"
    )
    code, _, _ = await _run(["wsl.exe", "--", "bash", "-lc", script], timeout=15)
    return code == 0


async def _apply_network_fix() -> tuple[bool, str]:
    """Switch WSL to mirrored networking so a host VPN's routes/DNS reach the
    distro, then `wsl --shutdown` so the new .wslconfig applies. No admin needed.

    Returns (success, log). Refuses (with guidance) when the host is too old to
    support mirrored networking, since writing it would be silently ignored."""
    build = _windows_build()
    wslver = await _wsl_app_version()
    if not _mirrored_supported(build, wslver):
        ver_str = ".".join(map(str, wslver)) if wslver else "unknown"
        return False, (
            "Mirrored networking needs Windows 11 22H2+ (build 22621) and WSL 2.0+. "
            f"Detected build {build or '?'}, WSL {ver_str}. "
            "Run `wsl --update` in PowerShell and retry, or use Fix DNS instead."
        )

    try:
        path = await asyncio.to_thread(_upsert_wslconfig, _MIRRORED_UPDATES)
    except OSError as exc:
        return False, f"Could not write {_wslconfig_path()}: {exc}"

    code, out, err = await _run(["wsl.exe", "--shutdown"], timeout=20)
    shut = "\n".join(s for s in [out.strip(), err.strip()] if s)
    if code != 0:
        return False, f"Wrote {path}, but `wsl --shutdown` failed: {shut}".strip()
    return True, (
        f"Enabled mirrored networking in {path} and restarted WSL. "
        "The VPN's routes and DNS are now shared with the distro."
    )


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

    settings_store = request.app.state.settings_store
    preference = settings_store.shell_preference

    # Native POSIX host: no WSL/PowerShell split — report a native status for the
    # onboarding checklist and the bash⇄zsh picker. Tool presence comes from PATH
    # (cheap); only the global-npm probe needs a subprocess.
    if sys.platform != "win32":
        node = shutil.which("node")
        npm = shutil.which("npm")
        python = shutil.which("python3") or shutil.which("python")
        pandoc = shutil.which("pandoc")
        libreoffice = shutil.which("libreoffice") or shutil.which("soffice")
        poppler = shutil.which("pdftotext") is not None
        docx = await _native_has_global_npm_pkg("docx") if npm else False

        missing = [
            key
            for key, present in (
                ("node", node), ("npm", npm), ("python", python), ("pandoc", pandoc),
                ("libreoffice", libreoffice), ("poppler", poppler), ("docx", docx),
            )
            if not present
        ]
        package_manager, install_command = _native_install_plan(missing)

        return WSLStatus(
            wsl_installed=False,
            default_distro=None,
            distro_running=False,
            node=node,
            python=python,
            npm=npm,
            pandoc=pandoc,
            libreoffice=libreoffice,
            poppler=poppler,
            docx=docx,
            dns_ok=True,
            internet_ok=True,
            mirrored_supported=False,
            mirrored_active=False,
            powershell_available=False,
            zsh_available=shutil.which("zsh") is not None,
            active_shell=resolve_active_shell(preference),
            shell_preference=preference,
            os_platform=_os_platform(),
            distro_name=_native_distro_name(),
            package_manager=package_manager,
            install_command=install_command,
        )

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
            internet_ok=False,
            mirrored_supported=False,
            mirrored_active=_read_wslconfig_mirrored(),
            powershell_available=ps_available,
            active_shell=resolve_active_shell(preference),
            shell_preference=preference,
            os_platform=_os_platform(),
        )

    distro = await _wsl_default_distro()
    distro_running = False
    node = python = npm = pandoc = libreoffice = None
    poppler = False
    docx = False
    dns_ok = False
    internet_ok = False

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
            internet_ok = await _wsl_internet_works()

    mirrored_supported = _mirrored_supported(_windows_build(), await _wsl_app_version())

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
        internet_ok=internet_ok,
        mirrored_supported=mirrored_supported,
        mirrored_active=_read_wslconfig_mirrored(),
        powershell_available=ps_available,
        active_shell=resolve_active_shell(preference),
        shell_preference=preference,
        os_platform=_os_platform(),
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


@router.post("/fix-network", response_model=InstallResult)
async def fix_network() -> InstallResult:
    """Repair WSL connectivity for VPN users via mirrored networking.

    Writes networkingMode=mirrored (+ dnsTunneling/autoProxy) to
    %USERPROFILE%\\.wslconfig and runs `wsl --shutdown`. On the next launch the
    distro shares the Windows network stack, so an active VPN's routes and DNS
    apply inside WSL too. No admin rights required. Use this when DNS resolves
    but there's still no internet (the classic VPN + WSL2 NAT failure)."""
    ok, log = await _apply_network_fix()
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
