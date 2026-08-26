"""Host execution dispatch — one platform switch for all shell/file plumbing.

On Windows the agent reaches its POSIX filesystem through ``wsl.exe``
(``agent.wsl_exec``); on a native Linux/macOS host the very same helpers run
against the local filesystem and ``/bin/bash`` directly (``agent.posix_exec``).
Every file tool (read_file, write_file, edit_file, read_photo, uploads,
chat-dir purge) funnels through here, so this single platform switch is what
makes those tools work on Linux without per-tool changes.

Call sites that are explicitly single-platform (the WSL chat-dir purge, the
AppImage env scrub) should import ``agent.wsl_exec`` / ``agent.posix_exec``
directly instead.
"""

from __future__ import annotations

import subprocess
import sys

from agent import posix_exec, wsl_exec
from agent.dir_listing import DirEntry, local_list_dir

# True on a native POSIX host — the agent runs bash and touches files directly
# instead of tunnelling through wsl.exe.
IS_POSIX = sys.platform != "win32"


async def host_run(
    bash_cmd: str,
    *,
    stdin: bytes | None = None,
    timeout: float = 300,
) -> subprocess.CompletedProcess[bytes]:
    """Run *bash_cmd* in a login bash — natively on POSIX, via wsl.exe on Windows.

    Does not raise on non-zero exit — caller inspects ``.returncode``.
    Raises ``FileNotFoundError`` if the shell binary is missing from PATH.
    """
    if IS_POSIX:
        return await posix_exec.posix_run(bash_cmd, stdin=stdin, timeout=timeout)
    return await wsl_exec.wsl_run(bash_cmd, stdin=stdin, timeout=timeout)


async def host_read_text(path: str) -> str:
    """Read a UTF-8 file. Raises FileNotFoundError or OSError on failure."""
    if IS_POSIX:
        return await posix_exec.posix_read_text(path)
    return await wsl_exec.wsl_read_text(path)


async def host_read_bytes(path: str, *, max_bytes: int | None = None) -> bytes:
    """Read a binary file. Returns raw bytes. Raises FileNotFoundError or OSError.

    ``max_bytes`` caps the read at its source on both platforms, which is the
    only place a cap helps: the WSL path pipes the bytes back through a buffer
    the parent holds whole.
    """
    if IS_POSIX:
        return await posix_exec.posix_read_bytes(path, max_bytes=max_bytes)
    return await wsl_exec.wsl_read_bytes(path, max_bytes=max_bytes)


async def host_list_dir(
    path: str,
    *,
    depth: int = 1,
    skip: frozenset[str] = frozenset(),
) -> list[DirEntry]:
    """List a directory — natively, or through WSL for a POSIX path on Windows.

    One rule more than the read/write helpers above: on Windows a drive-letter
    path (PowerShell shell mode) names the *host's* own filesystem, which the
    distro cannot see, so it is listed directly instead of being tunnelled.
    """
    if IS_POSIX or not path.startswith("/"):
        return await local_list_dir(path, depth=depth, skip=skip)
    return await wsl_exec.wsl_list_dir(path, depth=depth, skip=skip)


async def host_write_bytes(path: str, data: bytes, *, mkdir: bool = True, append: bool = False) -> None:
    """Write *data* to a path. Creates parent dirs by default.

    ``append=True`` preserves existing content. POSIX writes natively; Windows
    pipes the bytes into ``cat >`` inside WSL.
    """
    if IS_POSIX:
        await posix_exec.posix_write_bytes(path, data, mkdir=mkdir, append=append)
        return
    await wsl_exec.wsl_write_bytes(path, data, mkdir=mkdir, append=append)
