"""Shell detection — WSL bash vs Windows PowerShell.

Leaf module (standard library only) so any handler can resolve the active shell
without importing the app factory.
"""

from __future__ import annotations

import shutil
import subprocess
import sys

# Suppress the black Windows console flash that pops for every wsl.exe /
# powershell.exe / winget / npm spawn when the parent (backend.exe / python.exe)
# has no console attached. 0 (no-op flag) on non-Windows. Shared by every
# module that shells out — keep one source of truth for the platform flag.
NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # 0x08000000 on Windows


def wsl_available() -> bool:
    """True iff wsl.exe is on PATH. Cheap — just a PATH lookup."""
    return shutil.which("wsl") is not None


def powershell_available() -> bool:
    """True iff powershell.exe is on PATH. Always true on Windows."""
    return shutil.which("powershell") is not None or shutil.which("pwsh") is not None


def zsh_available() -> bool:
    """True iff a zsh binary is on PATH. Cheap — just a PATH lookup."""
    return shutil.which("zsh") is not None


def resolve_active_shell(preference: str) -> str:
    """Resolve the shell preference to a concrete "wsl" | "powershell" | "posix" | "zsh".

    On a native Linux/macOS host there is no WSL/PowerShell split — the agent
    runs the host's own bash by default ("posix"). A user who explicitly picks
    "zsh" gets "zsh" so bash_tool spawns /bin/zsh instead of /bin/bash; any other
    preference falls back to "posix". The WSL/PowerShell preferences only ever
    meant anything on Windows and are ignored here.

    On Windows: auto picks WSL when available, otherwise PowerShell. Forced
    modes return as-is; BashTool then surfaces a clear error if the chosen
    shell isn't installed. "zsh" is not a Windows option, so it falls through
    to the auto WSL/PowerShell resolution.
    """
    if sys.platform != "win32":
        return "zsh" if preference == "zsh" else "posix"
    if preference == "wsl":
        return "wsl"
    if preference == "powershell":
        return "powershell"
    return "wsl" if wsl_available() else "powershell"
