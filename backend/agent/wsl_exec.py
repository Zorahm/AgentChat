"""WSL execution — tunnels shell commands and file IO through ``wsl.exe``.

Windows-only leaf of the shell-execution stack: the agent reaches its POSIX
filesystem through ``wsl.exe``, so every helper here shells out to the default
WSL distribution. The native Linux/macOS twin lives in ``agent.posix_exec``;
the platform dispatch that picks between the two is ``agent.host_exec`` —
import from there unless a call site is explicitly WSL-only (e.g. the WSL
chat-dir purge in ``api/chats.py``).
"""

from __future__ import annotations

import shlex
import subprocess

from agent.exec_common import decode_loose, run_blocking


async def wsl_run(
    bash_cmd: str,
    *,
    stdin: bytes | None = None,
    timeout: float = 300,
) -> subprocess.CompletedProcess[bytes]:
    """Run *bash_cmd* in a login bash inside WSL: ``wsl.exe -- bash -lc <bash_cmd>``.

    ``--`` separates wsl.exe options from the command, ``-l`` (login shell)
    sources startup files so ``$HOME`` and PATH are complete inside the distro.

    Does not raise on non-zero exit — caller inspects ``.returncode``.
    Raises ``FileNotFoundError`` if wsl.exe is missing from PATH.
    """
    return await run_blocking(
        ["wsl.exe", "--", "bash", "-lc", bash_cmd], timeout=timeout, stdin=stdin
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
    """Write *data* to a WSL path by piping the bytes into ``cat >`` inside WSL.

    Creates parent dirs by default; ``append=True`` preserves existing content.
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
