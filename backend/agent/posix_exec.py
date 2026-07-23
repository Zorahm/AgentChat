"""Native POSIX (Linux/macOS) execution — local bash/zsh, local filesystem.

On a native POSIX host the agent runs the host's own shell and touches files
directly — no ``wsl.exe``, no ``/mnt/c`` translation. File plumbing (read/write)
always goes through Python's own filesystem APIs or ``bash``; only bash_tool
command execution ever swaps the interpreter to ``zsh`` (user preference), via
the ``binary`` parameter of :func:`posix_run`.

The platform dispatch itself lives in ``agent.host_exec`` — import from there
unless a call site is explicitly POSIX-only.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from agent.exec_common import decode_loose, run_blocking


def host_tool_env() -> dict[str, str] | None:
    """Env for spawning host tools (bash/node/python/pdftotext) from a bundled app.

    A PyInstaller onefile sidecar — and the AppImage that launched it — prepend
    their own private lib dirs to ``LD_LIBRARY_PATH``/``LD_PRELOAD``, and the
    AppImage runtime also points ``PYTHONHOME``/``PYTHONPATH`` at its own mounted
    ``usr/`` tree. A system binary like ``bash`` loads those bundled libraries
    (e.g. a mismatched ``libreadline``/``libtinfo``) instead of the host's and
    dies with a ``symbol lookup error`` / exit 127; a system ``python3`` given
    that ``PYTHONHOME`` fails even harder — it can't find its own stdlib
    (``ModuleNotFoundError: No module named 'encodings'``) and aborts on
    startup, which silently breaks the per-chat ``python3 -m venv`` provisioning
    in ``api/chats.py``. We strip only the bundle-private entries so spawned
    tools resolve against the host's own libraries/interpreter, while keeping
    any genuine user-set paths.

    Returns ``None`` when nothing needs cleaning (no pollution / not Linux),
    so callers can pass it straight to ``subprocess.run(env=...)`` — ``None``
    means "inherit the current environment unchanged".
    """
    markers: list[str] = []
    appdir = os.environ.get("APPDIR")
    if appdir:
        markers.append(appdir)
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        markers.append(str(meipass))

    def _is_bundle_path(p: str) -> bool:
        if not p:
            return True
        if any(p.startswith(m) for m in markers):
            return True
        # AppImage mounts at /tmp/.mount_*; PyInstaller extracts to /tmp/_MEI*.
        return "/.mount_" in p or "/_MEI" in p

    env = dict(os.environ)
    changed = False
    # All POSIX vars — always colon-separated, regardless of the host
    # os.pathsep (which is ';' on Windows). PYTHONHOME is technically
    # `home` or `home:exec_prefix`, so the same split/filter/rejoin logic
    # applies cleanly.
    for var in ("LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH"):
        val = env.get(var)
        if not val:
            continue
        parts = val.split(":")
        kept = [p for p in parts if not _is_bundle_path(p)]
        if len(kept) != len(parts):
            changed = True
            if kept:
                env[var] = ":".join(kept)
            else:
                env.pop(var, None)
    return env if changed else None


async def posix_run(
    shell_cmd: str,
    *,
    binary: str = "bash",
    stdin: bytes | None = None,
    timeout: float = 300,
) -> subprocess.CompletedProcess[bytes]:
    """Run *shell_cmd* in a login shell on the host: ``<binary> -lc <shell_cmd>``.

    ``-l`` (login shell) sources startup files so ``$HOME`` and PATH are
    complete. ``binary`` is ``bash`` for all file plumbing; bash_tool may pass
    ``zsh`` when the user explicitly picked it. Spawns with
    :func:`host_tool_env` so a bundled app's private libs never poison the tool.

    Does not raise on non-zero exit — caller inspects ``.returncode``.
    Raises ``FileNotFoundError`` if the shell binary is missing from PATH.
    """
    return await run_blocking(
        [binary, "-lc", shell_cmd], timeout=timeout, stdin=stdin, env=host_tool_env()
    )


async def posix_read_text(path: str) -> str:
    """Read a UTF-8 file natively. Raises FileNotFoundError or OSError on failure.

    Bytes are decoded leniently (matching the WSL path's ``decode_loose``) so a
    non-UTF-8 file never raises mid-tool.
    """
    data = await asyncio.to_thread(Path(path).read_bytes)
    return decode_loose(data)


async def posix_read_bytes(path: str) -> bytes:
    """Read a binary file natively. Raises FileNotFoundError or OSError on failure."""
    return await asyncio.to_thread(Path(path).read_bytes)


async def posix_write_bytes(path: str, data: bytes, *, mkdir: bool = True, append: bool = False) -> None:
    """Write *data* to a local path. Creates parent dirs by default.

    ``append=True`` preserves existing content.
    """

    def _write() -> None:
        p = Path(path)
        if mkdir:
            p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("ab" if append else "wb") as fp:
            fp.write(data)

    await asyncio.to_thread(_write)
