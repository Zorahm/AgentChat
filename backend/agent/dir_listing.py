"""Directory listings — the shape file tools consume, plus the native reader.

Every backend of :func:`agent.host_exec.host_list_dir` returns the same
:class:`DirEntry` list, so the ``list_dir`` tool renders one structure whether
the entries came from this process's own filesystem or from ``find`` inside WSL.

A leaf module: imports nothing from the app.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class DirEntry:
    """One entry of a directory listing, relative to the directory listed."""

    #: Path relative to the listed root, always forward-slash separated.
    rel: str
    is_dir: bool
    #: Size in bytes; 0 for directories and for entries we could not stat.
    size: int


async def local_list_dir(
    path: str,
    *,
    depth: int = 1,
    skip: frozenset[str] = frozenset(),
) -> list[DirEntry]:
    """List *path* on the filesystem this process can see directly.

    Raises ``FileNotFoundError`` / ``NotADirectoryError`` / ``OSError`` for the
    root; unreadable *sub*directories are skipped rather than failing the whole
    listing. Symlinks are reported as-is and never followed — a listing must not
    be able to walk out of the directory it was pointed at.
    """
    return await asyncio.to_thread(_walk, path, depth, skip)


def _walk(root: str, depth: int, skip: frozenset[str]) -> list[DirEntry]:
    entries: list[DirEntry] = []
    # (directory to scan, prefix for the entries it yields, its level)
    pending: list[tuple[str, str, int]] = [(root, "", 1)]
    is_root = True

    while pending:
        current, prefix, level = pending.pop(0)
        try:
            with os.scandir(current) as it:
                for item in it:
                    rel = f"{prefix}{item.name}"
                    is_dir = _safe_is_dir(item)
                    entries.append(
                        DirEntry(rel=rel, is_dir=is_dir, size=0 if is_dir else _safe_size(item))
                    )
                    if is_dir and level < depth and item.name not in skip:
                        pending.append((item.path, f"{rel}/", level + 1))
        except OSError:
            if is_root:
                raise
        is_root = False

    return entries


def _safe_is_dir(item: os.DirEntry[str]) -> bool:
    try:
        return item.is_dir(follow_symlinks=False)
    except OSError:
        return False


def _safe_size(item: os.DirEntry[str]) -> int:
    try:
        return item.stat(follow_symlinks=False).st_size
    except OSError:
        return 0
