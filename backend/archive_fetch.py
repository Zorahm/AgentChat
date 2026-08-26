"""Downloading and unpacking zip archives — the shared half of both installers.

Skills and plugins are both distributed as GitHub repositories and as loose
zips, and both land in a shared tree under ``~/.agents``. That makes the
Zip-Slip guard here load-bearing: a member path is attacker-controlled data,
and one archive that escapes its destination reaches the rest of the tree.

A leaf: the standard library only, so it can sit under either installer.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

# GitHub serves a repository's default branch under whichever name it uses;
# trying both covers every repo without an API call.
GITHUB_BRANCHES: tuple[str, ...] = ("main", "master")

_DRIVE_RE = re.compile(r"^[a-zA-Z]:")
_FETCH_TIMEOUT = 30


def github_zip_url(owner: str, repo: str, branch: str) -> str:
    return f"https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip"


def fetch(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "AgentChat/1.0"})
    with urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return bytes(resp.read())


def is_safe_member(member: str) -> bool:
    """Reject absolute paths, drive letters and ``..`` segments (Zip Slip)."""
    if not member or member.startswith(("/", "\\")):
        return False
    if _DRIVE_RE.match(member):
        return False
    return ".." not in member.replace("\\", "/").split("/")


def extract_zip(data: bytes, dest: Path, prefix: str = "") -> int:
    """Unpack *data* into *dest*, keeping only members under *prefix*.

    *prefix* is stripped from each name, which is how a GitHub archive's
    ``<repo>-<branch>/`` wrapper (and an optional subdirectory below it) is
    removed. Returns the number of files written. Raises ``ValueError`` on an
    unsafe member — before writing anything, so a rejected archive leaves no
    partial tree.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        for member in names:
            if not is_safe_member(member):
                raise ValueError(f"Unsafe path in archive: {member!r}")

        written = 0
        dest.mkdir(parents=True, exist_ok=True)
        for member in names:
            if not member.startswith(prefix):
                continue
            relative = member[len(prefix) :]
            if not relative:
                continue
            target = dest / relative
            if member.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(member))
            written += 1
        return written
