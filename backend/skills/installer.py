"""Skills 2.0 installer — downloads from GitHub into ~/.agents/skills/.

Drops a ``.agentchat-installed`` marker file at the root of every install so
the uninstall endpoint can tell apart skills WE put on disk from skills the
user (or other agent systems like Claude Code) have placed in the shared
``~/.agents/skills/`` tree. Without the marker, DELETE refuses to touch the
folder.
"""

from __future__ import annotations

import io
import re
import shutil
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from skills.catalog import ANTHROPIC_ALLOWED_DIR_NAMES, ANTHROPIC_DISPLAY_NAME, ANTHROPIC_SOURCE
from skills.reader import AgentSkillsReader, SkillEntry, _parse_frontmatter


_SAFE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_\-\.]*$", re.IGNORECASE)

MARKER_NAME = ".agentchat-installed"


def _ensure_author_field(skill_md: Path, author: str) -> None:
    """Add ``author: <author>`` to a SKILL.md's frontmatter if it has none.

    Anthropic's own skills (fetched unmodified via install_subdir) don't
    self-attribute in frontmatter, unlike our bundled/adapted copies — so the
    Skills UI would otherwise show no author line at all for them, while every
    other curated skill shows one.
    """
    try:
        text = skill_md.read_text("utf-8")
    except OSError:
        return
    meta, _ = _parse_frontmatter(text)
    if meta.get("author"):
        return

    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.strip() == "---":
            lines.insert(i + 1, f"author: {author}\n")
            break
    else:
        return  # no frontmatter block — leave the file alone

    try:
        skill_md.write_text("".join(lines), encoding="utf-8")
    except OSError:
        pass


def _is_subpath(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _safe_member_path(member: str) -> bool:
    """Reject absolute paths, drive letters and '..' segments (Zip Slip)."""
    if not member or member.startswith(("/", "\\")):
        return False
    if re.match(r"^[a-zA-Z]:", member):
        return False
    parts = member.replace("\\", "/").split("/")
    return ".." not in parts


def _has_marker_above(skill_path: Path, root: Path) -> bool:
    """True iff a ``.agentchat-installed`` file exists at skill_path or any
    parent up to *root* (inclusive). Used to decide if DELETE may proceed.
    """
    try:
        skill_r = skill_path.resolve()
        root_r = root.resolve()
        skill_r.relative_to(root_r)
    except (ValueError, OSError):
        return False
    cur = skill_r
    while True:
        if (cur / MARKER_NAME).is_file():
            return True
        if cur == root_r:
            return False
        cur = cur.parent


class GitHubSkillInstaller:
    # Noise we never copy when installing a bundled skill from a local dir.
    _COPY_IGNORE = ("__pycache__", "*.pyc", ".git", ".DS_Store", "node_modules")

    def __init__(
        self,
        skills_dir: Path,
        reader: AgentSkillsReader,
    ) -> None:
        self.skills_dir = skills_dir
        self._reader = reader

    @staticmethod
    def _write_marker(dest: Path, source: str) -> None:
        try:
            (dest / MARKER_NAME).write_text(
                f"installed-by=agentchat\nsource={source}\n", encoding="utf-8"
            )
        except OSError:
            pass  # marker is best-effort; install itself already succeeded

    def is_installed_by_us(self, skill_path: Path) -> bool:
        """True iff *skill_path* lives under our install root AND has a marker
        file at or above it. Lets the API tell our installs apart from sibling
        skills planted by Claude Code et al.
        """
        return _has_marker_above(skill_path, self.skills_dir)

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

        # Refuse to clobber a directory we didn't install — would otherwise
        # silently overwrite a skill the user (or another agent system) placed
        # in ~/.agents/skills/ by hand.
        if dest.exists() and not _has_marker_above(dest, self.skills_dir):
            raise ValueError(
                f"'{repo}' already exists at {dest} and wasn't installed by AgentChat. "
                f"Remove it manually if you really want to replace it."
            )
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

        # The Anthropic repo carries ~17 skills; we only want the curated few.
        # Prune the rest so a full-repo install matches the catalog cards.
        if source.lower() == ANTHROPIC_SOURCE:
            for md in skill_md_files:
                if md.parent.name not in ANTHROPIC_ALLOWED_DIR_NAMES:
                    shutil.rmtree(md.parent, ignore_errors=True)
            skill_md_files = list(dest.rglob("SKILL.md"))
            if not skill_md_files:
                shutil.rmtree(dest, ignore_errors=True)
                raise ValueError(f"'{source}' yielded no curated skills after filtering")
            for md in skill_md_files:
                _ensure_author_field(md, ANTHROPIC_DISPLAY_NAME)

        self._write_marker(dest, source=source)
        self._reader.rebuild()

        # Collect every skill whose dir lives under the freshly-installed repo
        installed: list[SkillEntry] = [
            e for e in self._reader.list_skills() if _is_subpath(e.path, dest)
        ]
        if not installed:
            raise RuntimeError(f"Skills installed to {dest} but none found after rebuild")
        return installed

    def install_subdir(self, repo_source: str, subdir: str, install_as: str) -> list[SkillEntry]:
        """Install a single skill folder (*subdir*) out of a GitHub repo.

        Downloads the repo archive, extracts only the members under *subdir*
        into ``skills_dir/install_as``. Used by the curated-catalog install so
        each picked skill lands as its own top-level folder.
        """
        repo_source = repo_source.strip().strip("/")
        parts = [p for p in repo_source.split("/") if p]
        if len(parts) < 2:
            raise ValueError(f"Expected 'owner/repo', got '{repo_source}'")
        if not _SAFE_NAME_RE.match(install_as):
            raise ValueError(f"Unsafe skill name: '{install_as}'")

        owner, repo = parts[0], parts[1]
        subdir = subdir.strip("/")
        dest = self.skills_dir / install_as

        if dest.exists() and not _has_marker_above(dest, self.skills_dir):
            raise ValueError(
                f"'{install_as}' already exists at {dest} and wasn't installed by "
                f"AgentChat. Remove it manually if you really want to replace it."
            )
        if dest.exists():
            shutil.rmtree(dest)

        downloaded = False
        for branch in ("main", "master"):
            url = f"https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip"
            try:
                data = self._fetch(url)
                self._extract(data, dest, prefix=f"{repo}-{branch}/{subdir}/")
                downloaded = True
                break
            except HTTPError as exc:
                if exc.code == 404 and branch == "main":
                    continue
                raise ValueError(f"Cannot download '{repo_source}': HTTP {exc.code}") from exc
            except URLError as exc:
                raise ValueError(f"Network error for '{repo_source}': {exc.reason}") from exc

        if not downloaded:
            raise ValueError(f"Repository '{repo_source}' not found on GitHub")

        skill_md_files = list(dest.rglob("SKILL.md"))
        if not skill_md_files:
            shutil.rmtree(dest, ignore_errors=True)
            raise ValueError(f"'{subdir}' in '{repo_source}' has no SKILL.md")

        if repo_source.lower() == ANTHROPIC_SOURCE:
            for md in skill_md_files:
                _ensure_author_field(md, ANTHROPIC_DISPLAY_NAME)

        self._write_marker(dest, source=f"{repo_source}/{subdir}")
        self._reader.rebuild()
        installed: list[SkillEntry] = [
            e for e in self._reader.list_skills() if _is_subpath(e.path, dest)
        ]
        if not installed:
            raise RuntimeError(f"Skill installed to {dest} but none found after rebuild")
        return installed

    def install_local(self, source_dir: Path, install_as: str) -> list[SkillEntry]:
        """Install a single skill folder by copying it from a local directory.

        Used by the curated catalog for the bundled office skills (docx/xlsx/
        pptx/pdf): they ship with the app, so installation is an offline
        ``copytree`` from the bundled source into ``skills_dir/install_as``.
        """
        if not _SAFE_NAME_RE.match(install_as):
            raise ValueError(f"Unsafe skill name: '{install_as}'")
        if not source_dir.is_dir():
            raise ValueError(f"Bundled skill not found at {source_dir}")
        if not (source_dir / "SKILL.md").is_file() and not list(source_dir.rglob("SKILL.md")):
            raise ValueError(f"'{source_dir}' has no SKILL.md")

        dest = self.skills_dir / install_as
        if dest.exists() and not _has_marker_above(dest, self.skills_dir):
            raise ValueError(
                f"'{install_as}' already exists at {dest} and wasn't installed by "
                f"AgentChat. Remove it manually if you really want to replace it."
            )
        if dest.exists():
            shutil.rmtree(dest)

        self.skills_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_dir, dest, ignore=shutil.ignore_patterns(*self._COPY_IGNORE))

        self._write_marker(dest, source=f"bundled:{install_as}")
        self._reader.rebuild()
        installed: list[SkillEntry] = [
            e for e in self._reader.list_skills() if _is_subpath(e.path, dest)
        ]
        if not installed:
            raise RuntimeError(f"Skill installed to {dest} but none found after rebuild")
        return installed

    def install_from_archive(self, archive_bytes: bytes, filename: str) -> list[SkillEntry]:
        """Install one or more skills from a local archive (.skill / .zip).

        The archive must contain at least one SKILL.md at any depth. Filename
        (sans extension) determines the install folder under skills_dir/.
        """
        stem = Path(filename).stem or "skill"
        if not _SAFE_NAME_RE.match(stem):
            raise ValueError(f"Unsafe archive name: '{filename}'")

        dest = self.skills_dir / stem
        if dest.exists() and not _has_marker_above(dest, self.skills_dir):
            raise ValueError(
                f"'{stem}' already exists at {dest} and wasn't installed by AgentChat. "
                f"Remove it manually if you really want to replace it."
            )
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True, exist_ok=True)

        try:
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
                for member in zf.namelist():
                    if not _safe_member_path(member):
                        shutil.rmtree(dest, ignore_errors=True)
                        raise ValueError(f"Unsafe path in archive: '{member}'")
                for member in zf.namelist():
                    rel = member.replace("\\", "/")
                    target = dest / rel
                    if member.endswith("/"):
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(zf.read(member))
        except zipfile.BadZipFile as exc:
            shutil.rmtree(dest, ignore_errors=True)
            raise ValueError(f"Not a valid zip archive: {exc}") from exc

        skill_md_files = list(dest.rglob("SKILL.md"))
        if not skill_md_files:
            shutil.rmtree(dest, ignore_errors=True)
            raise ValueError(f"'{filename}' contains no SKILL.md — not a valid Skills 2.0 package")

        self._write_marker(dest, source=filename)
        self._reader.rebuild()
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
