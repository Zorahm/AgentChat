"""WSL subprocess helpers — blocking subprocess in a thread.

asyncio.create_subprocess_exec raises NotImplementedError on Windows
SelectorEventLoop (which uvicorn sometimes installs). Running blocking
subprocess.run in asyncio.to_thread works on any event loop policy.
"""

from __future__ import annotations

import asyncio
import shlex
import subprocess


async def wsl_run(
    bash_cmd: str,
    *,
    stdin: bytes | None = None,
    timeout: float = 300,
) -> subprocess.CompletedProcess[bytes]:
    """Run ``wsl.exe bash -c <bash_cmd>``; return the CompletedProcess.

    Does not raise on non-zero exit — caller inspects ``.returncode``.
    Raises ``FileNotFoundError`` if wsl.exe is missing from PATH.
    """
    return await asyncio.to_thread(
        subprocess.run,
        ["wsl.exe", "bash", "-c", bash_cmd],
        input=stdin,
        capture_output=True,
        timeout=timeout,
    )


async def wsl_read_text(path: str) -> str:
    """Read a UTF-8 file from WSL. Raises FileNotFoundError or OSError on failure."""
    result = await wsl_run(f"cat {shlex.quote(path)}")
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace").strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err or path)
        raise OSError(err or f"wsl cat failed with code {result.returncode}")
    return result.stdout.decode("utf-8", errors="replace")


async def wsl_write_bytes(path: str, data: bytes, *, mkdir: bool = True, append: bool = False) -> None:
    """Write *data* to a WSL path. Creates parent dirs by default.

    ``append=True`` uses ``cat >>`` so existing content is preserved.
    """
    redirect = ">>" if append else ">"
    quoted = shlex.quote(path)
    parts = [f"cat {redirect} {quoted}"]
    if mkdir:
        parts.insert(0, f"mkdir -p $(dirname {quoted})")
    cmd = " && ".join(parts)
    result = await wsl_run(cmd, stdin=data)
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace").strip()
        raise OSError(err or f"wsl write failed with code {result.returncode}")
