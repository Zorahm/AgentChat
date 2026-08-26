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

from agent.dir_listing import DirEntry
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


async def wsl_read_bytes(path: str, *, max_bytes: int | None = None) -> bytes:
    """Read a binary file from WSL. Returns raw bytes. Raises FileNotFoundError or OSError.

    ``max_bytes`` stops the read inside the distro rather than after the fact:
    the bytes travel back through a pipe and are buffered whole by the parent,
    so slicing on this side would already have paid the memory.
    """
    quoted = shlex.quote(path)
    # `--` ends option parsing so a path beginning with `-` is still a path;
    # head reports "No such file" / "Is a directory" the same way cat does, so
    # the error mapping below covers both commands.
    cmd = f"cat {quoted}" if max_bytes is None else f"head -c {int(max_bytes)} -- {quoted}"
    result = await wsl_run(cmd)
    if result.returncode != 0:
        err = decode_loose(result.stderr).strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err or path)
        raise OSError(err or f"wsl cat failed with code {result.returncode}")
    return result.stdout


async def wsl_list_dir(
    path: str,
    *,
    depth: int = 1,
    skip: frozenset[str] = frozenset(),
) -> list[DirEntry]:
    """List a WSL directory with ``find``, one ``type\\tsize\\trelpath`` line each.

    ``find`` does the whole walk in a single wsl.exe round trip — one process
    start instead of one per subdirectory, which is what makes a deep listing
    bearable through the WSL boundary. Pruned directories are still *printed*
    (``-prune -printf``), just not descended into, so the listing matches what
    the native walk produces.
    """
    quoted = shlex.quote(path)
    fmt = r"-printf '%y\t%s\t%P\n'"
    prune = ""
    if skip and depth > 1:
        names = " -o ".join(f"-name {shlex.quote(n)}" for n in sorted(skip))
        prune = f"\\( {names} \\) -prune {fmt} -o "
    cmd = f"find {quoted} -mindepth 1 -maxdepth {int(depth)} {prune}{fmt}"

    result = await wsl_run(cmd)
    entries = _parse_find_lines(decode_loose(result.stdout))
    if result.returncode != 0 and not entries:
        # A partial failure (one unreadable subdirectory) still prints the rest,
        # so only a listing with nothing in it is treated as an error.
        err = decode_loose(result.stderr).strip()
        if "No such file" in err:
            raise FileNotFoundError(err or path)
        if "Not a directory" in err:
            raise NotADirectoryError(err or path)
        raise OSError(err or f"wsl find failed with code {result.returncode}")
    return entries


def _parse_find_lines(out: str) -> list[DirEntry]:
    """Parse ``find -printf '%y\\t%s\\t%P\\n'`` output into entries."""
    entries: list[DirEntry] = []
    for line in out.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3 or not parts[2]:
            continue
        kind, raw_size, rel = parts
        is_dir = kind == "d"
        try:
            size = 0 if is_dir else int(raw_size)
        except ValueError:
            size = 0
        entries.append(DirEntry(rel=rel, is_dir=is_dir, size=size))
    return entries


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
