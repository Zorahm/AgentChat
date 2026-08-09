import shutil
import sys

from fastapi import APIRouter

import server_mode

router = APIRouter()


def _os_platform() -> str:
    """Coarse host OS for the UI: windows | darwin | linux."""
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


@router.get("/system-status")
async def system_status() -> dict:
    return {
        "wsl_available": shutil.which("wsl") is not None,
        "os_platform": _os_platform(),
        # True when this backend runs as a shared server. The client hides the
        # affordances that only make sense next to a local sidecar (pairing QR,
        # backend restart) — none of them would work against a remote host.
        "server_mode": server_mode.enabled(),
    }
