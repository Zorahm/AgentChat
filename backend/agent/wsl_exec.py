"""WSL subprocess helpers — blocking subprocess in a thread.

asyncio.create_subprocess_exec raises NotImplementedError on Windows
SelectorEventLoop (which uvicorn sometimes installs). Running blocking
subprocess.run in asyncio.to_thread works on any event loop policy.
"""

from __future__ import annotations

import asyncio
import shlex
import subprocess

# Suppress the black console flash that Windows would otherwise pop for every
# wsl.exe spawn when the parent (backend.exe / python.exe) itself has no
# console attached. 0 on non-Windows so the kwarg is a no-op.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def decode_loose(data: bytes) -> str:
    """Best-effort bytes → str. WSL CLI sometimes emits UTF-16LE."""
    if not data:
        return ""
    try:
        s = data.decode("utf-8")
        if "\x00" in s:
            raise UnicodeDecodeError("utf-8", data, 0, 1, "looks like utf-16")
        return s
    except UnicodeDecodeError:
        try:
            return data.decode("utf-16-le").replace("\x00", "")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")


async def wsl_run(
    bash_cmd: str,
    *,
    stdin: bytes | None = None,
    timeout: float = 300,
) -> subprocess.CompletedProcess[bytes]:
    """Run ``wsl.exe -- bash -lc <bash_cmd>``; return the CompletedProcess.

    Uses ``--`` to separate wsl.exe options from the command, and ``-l``
    (login shell) so startup files are sourced — without it ``$HOME``
    and PATH may be incomplete inside the distro.

    Does not raise on non-zero exit — caller inspects ``.returncode``.
    Raises ``FileNotFoundError`` if wsl.exe is missing from PATH.
    """
    return await asyncio.to_thread(
        subprocess.run,
        ["wsl.exe", "--", "bash", "-lc", bash_cmd],
        input=stdin,
        capture_output=True,
        timeout=timeout,
        creationflags=_NO_WINDOW,
    )


async def wsl_read_text(path: str) -> str:
    """Read a UTF-8 file from WSL. Raises FileNotFoundError or OSError on failure."""
    result = await wsl_run(f"cat {shlex.quote(path)}")
    if result.returncode != 0:
        err = decode_loose(result.stderr).strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err or path)
        raise OSError(err or f"wsl cat failed with code {result.returncode}")
    return decode_loose(result.stdout)


async def wsl_read_bytes(path: str) -> bytes:
    """Read a binary file from WSL. Returns raw bytes. Raises FileNotFoundError or OSError."""
    result = await wsl_run(f"cat {shlex.quote(path)}")
    if result.returncode != 0:
        err = decode_loose(result.stderr).strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err or path)
        raise OSError(err or f"wsl cat failed with code {result.returncode}")
    return result.stdout


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
        err = decode_loose(result.stderr).strip()
        raise OSError(err or f"wsl write failed with code {result.returncode}")
