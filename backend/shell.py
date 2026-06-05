"""Shell detection — WSL bash vs Windows PowerShell.

Leaf module (standard library only) so any handler can resolve the active shell
without importing the app factory.
"""

from __future__ import annotations

import shutil


def wsl_available() -> bool:
    """True iff wsl.exe is on PATH. Cheap — just a PATH lookup."""
    return shutil.which("wsl") is not None


def powershell_available() -> bool:
    """True iff powershell.exe is on PATH. Always true on Windows."""
    return shutil.which("powershell") is not None or shutil.which("pwsh") is not None


def resolve_active_shell(preference: str) -> str:
    """Resolve the auto/wsl/powershell preference to a concrete "wsl" or "powershell".

    Auto: WSL when available, otherwise PowerShell. Forced modes return as-is;
    BashTool then surfaces a clear error if the chosen shell isn't installed.
    """
    if preference == "wsl":
        return "wsl"
    if preference == "powershell":
        return "powershell"
    return "wsl" if wsl_available() else "powershell"
