"""Shell subprocess helpers — blocking subprocess in a thread.

On Windows the agent reaches its POSIX filesystem through ``wsl.exe``; on a
native Linux/macOS host (``sys.platform != "win32"``) the very same helpers run
against the local filesystem and ``/bin/bash`` directly — no ``wsl.exe``, no
``/mnt/c`` translation. Every file tool (read_file, write_file, edit_file,
read_photo, the <file>/<edit> stream tags, uploads, chat-dir purge) funnels
through here, so this single platform switch is what makes those tools work on
Linux without per-tool changes.

asyncio.create_subprocess_exec raises NotImplementedError on Windows
SelectorEventLoop (which uvicorn sometimes installs). Running blocking
subprocess.run in asyncio.to_thread works on any event loop policy.
"""

from __future__ import annotations

import asyncio
import shlex
import subprocess
import sys
from pathlib import Path

# True on a native POSIX host — the agent runs bash and touches files directly
# instead of tunnelling through wsl.exe.
IS_POSIX = sys.platform != "win32"

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
    """Run *bash_cmd* in a login bash and return the CompletedProcess.

    Windows: ``wsl.exe -- bash -lc <bash_cmd>`` — ``--`` separates wsl.exe
    options from the command, ``-l`` (login shell) sources startup files so
    ``$HOME`` and PATH are complete inside the distro.

    POSIX (Linux/macOS): ``bash -lc <bash_cmd>`` directly against the host.

    Does not raise on non-zero exit — caller inspects ``.returncode``.
    Raises ``FileNotFoundError`` if the shell binary is missing from PATH.
    """
    if IS_POSIX:
        argv = ["bash", "-lc", bash_cmd]
    else:
        argv = ["wsl.exe", "--", "bash", "-lc", bash_cmd]
    return await asyncio.to_thread(
        subprocess.run,
        argv,
        input=stdin,
        capture_output=True,
        timeout=timeout,
        creationflags=_NO_WINDOW,
    )


async def wsl_read_text(path: str) -> str:
    """Read a UTF-8 file. Raises FileNotFoundError or OSError on failure.

    POSIX reads natively; bytes are decoded leniently (matching the WSL path's
    ``decode_loose``) so a non-UTF-8 file never raises mid-tool.
    """
    if IS_POSIX:
        data = await asyncio.to_thread(Path(path).read_bytes)
        return decode_loose(data)
    result = await wsl_run(f"cat {shlex.quote(path)}")
    if result.returncode != 0:
        err = decode_loose(result.stderr).strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err or path)
        raise OSError(err or f"wsl cat failed with code {result.returncode}")
    return decode_loose(result.stdout)


async def wsl_read_bytes(path: str) -> bytes:
    """Read a binary file. Returns raw bytes. Raises FileNotFoundError or OSError."""
    if IS_POSIX:
        return await asyncio.to_thread(Path(path).read_bytes)
    result = await wsl_run(f"cat {shlex.quote(path)}")
    if result.returncode != 0:
        err = decode_loose(result.stderr).strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err or path)
        raise OSError(err or f"wsl cat failed with code {result.returncode}")
    return result.stdout


async def wsl_write_bytes(path: str, data: bytes, *, mkdir: bool = True, append: bool = False) -> None:
    """Write *data* to a path. Creates parent dirs by default.

    ``append=True`` preserves existing content. POSIX writes natively; Windows
    pipes the bytes into ``cat >`` inside WSL.
    """
    if IS_POSIX:
        def _write() -> None:
            p = Path(path)
            if mkdir:
                p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("ab" if append else "wb") as fp:
                fp.write(data)

        await asyncio.to_thread(_write)
        return

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
