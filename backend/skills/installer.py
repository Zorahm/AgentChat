"""Skills 2.0 installer — downloads from GitHub into .agents/skills/."""

from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from skills.reader import AgentSkillsReader, SkillEntry


def _is_subpath(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


class GitHubSkillInstaller:
    def __init__(self, skills_dir: Path, reader: AgentSkillsReader) -> None:
        self.skills_dir = skills_dir
        self._reader = reader

    def install(self, source: str) -> list[SkillEntry]:
        """Install one or more skills from a GitHub 'owner/repo' string.

        Supports both single-skill repos (SKILL.md at root) and collections
        (multiple SKILL.md files nested anywhere in the tree).
        """
        source = source.strip().strip("/")
        parts = [p for p in source.split("/") if p]
        if len(parts) < 2:
            raise ValueError(f"Expected 'owner/repo', got '{source}'")

        owner, repo = parts[0], parts[1]
        dest = self.skills_dir / repo

        if dest.exists():
            shutil.rmtree(dest)

        # Try main then master
        downloaded = False
        for branch in ("main", "master"):
            url = f"https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip"
            try:
                data = self._fetch(url)
                self._extract(data, dest, prefix=f"{repo}-{branch}/")
                downloaded = True
                break
            except HTTPError as exc:
                if exc.code == 404 and branch == "main":
                    continue
                raise ValueError(f"Cannot download '{source}': HTTP {exc.code}") from exc
            except URLError as exc:
                raise ValueError(f"Network error for '{source}': {exc.reason}") from exc

        if not downloaded:
            raise ValueError(f"Repository '{source}' not found on GitHub")

        # Find every SKILL.md anywhere in the extracted tree
        skill_md_files = list(dest.rglob("SKILL.md"))
        if not skill_md_files:
            shutil.rmtree(dest, ignore_errors=True)
            raise ValueError(f"'{source}' contains no SKILL.md — not a valid Skills 2.0 package")

        self._reader.rebuild()

        # Collect every skill whose dir lives under the freshly-installed repo
        installed: list[SkillEntry] = [
            e for e in self._reader.list_skills() if _is_subpath(e.path, dest)
        ]
        if not installed:
            raise RuntimeError(f"Skills installed to {dest} but none found after rebuild")
        return installed

    def _fetch(self, url: str) -> bytes:
        req = Request(url, headers={"User-Agent": "AgentChat/1.0"})
        with urlopen(req, timeout=30) as resp:
            return resp.read()  # type: ignore[return-value]

    def _extract(self, data: bytes, dest: Path, prefix: str) -> None:
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for member in zf.namelist():
                if not member.startswith(prefix):
                    continue
                rel = member[len(prefix):]
                if not rel:
                    continue
                target = dest / rel
                if member.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(member))
