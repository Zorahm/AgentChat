"""Content fingerprint of a skill folder — a leaf shared by installer and sync.

Lives on its own so ``skills.installer`` can stamp a fingerprint into the install
marker while ``skills.bundled_sync`` reads it back, without the two importing
each other.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

# Never part of the fingerprint: the install marker is written *after* the copy
# (it would change its own input), and the rest is build noise a copy drops.
IGNORED_NAMES: frozenset[str] = frozenset({".agentchat-installed", ".DS_Store"})
IGNORED_DIRS: frozenset[str] = frozenset({"__pycache__", ".git", "node_modules"})


def fingerprint(root: Path) -> str:
    """Stable sha256 over a folder's relative paths and file contents.

    Paths are hashed alongside the bytes, so adding or renaming a file registers
    even when nothing else changed. Sorted, so the result never depends on the
    order the filesystem hands entries back.
    """
    digest = hashlib.sha256()
    for path in sorted(_iter_files(root)):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"<unreadable>")
        digest.update(b"\0")
    return digest.hexdigest()


def _iter_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        # `.pyc` mirrors the installer's own copy-ignore list — a file that is
        # never copied must never enter the hash, or the copy would look edited.
        if not path.is_file() or path.name in IGNORED_NAMES or path.suffix == ".pyc":
            continue
        if any(part in IGNORED_DIRS for part in path.relative_to(root).parts):
            continue
        files.append(path)
    return files
