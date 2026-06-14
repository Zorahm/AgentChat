"""Skills 2.0 reader — scans .agents/skills/ for SKILL.md files."""

from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path


_BLOCK_SCALAR_MARKERS = frozenset({"|", ">", "|-", "|+", ">-", ">+"})


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Parse YAML-like frontmatter. Handles simple values plus | and > block scalars."""
    # Strip BOM and normalize line endings so file-creation quirks don't break parsing.
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    # Trim leading blank lines — editors sometimes insert one before the first ---.
    text = text.lstrip("\n")
    if not text.startswith("---"):
        return {}, text

    rest = text[3:].lstrip("\n")
    end_idx = rest.find("\n---")
    if end_idx == -1:
        return {}, text

    fm_block = rest[:end_idx]
    body = rest[end_idx + 4:].lstrip("\n")

    meta: dict[str, str] = {}
    lines = fm_block.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if val in _BLOCK_SCALAR_MARKERS:
                # Block scalar (| literal, > folded) — collect indented continuations
                block: list[str] = []
                i += 1
                while i < len(lines):
                    nxt = lines[i]
                    if not nxt.strip():
                        block.append("")
                        i += 1
                        continue
                    if nxt[0] not in " \t":
                        break
                    block.append(nxt.strip())
                    i += 1
                meta[key] = " ".join(s for s in block if s).strip()
                continue
            meta[key] = val.strip('"').strip("'")
        i += 1

    return meta, body


@dataclass
class SkillEntry:
    name: str
    description: str
    version: str
    author: str
    path: Path  # directory containing SKILL.md


class AgentSkillsReader:
    """Scans .agents/skills/ directory for Skills 2.0 SKILL.md files."""

    _PROMPT_TEMPLATE = "### Installed skills\n\n{descriptions}"

    def __init__(self, skills_dir: Path | Iterable[Path]) -> None:
        if isinstance(skills_dir, Path):
            self.skills_dirs: list[Path] = [skills_dir]
        else:
            self.skills_dirs = list(skills_dir)
        # First entry is treated as the "primary" install location (used by callers
        # like the installer); kept as a separate attr for backwards compatibility.
        self.skills_dir: Path = self.skills_dirs[0]
        self._skills: dict[str, SkillEntry] = {}
        self._last_scan_ts: float = 0.0

    _SKIP_DIRS = frozenset({".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"})

    def rebuild(self, force: bool = False) -> None:
        """Scan all configured skill directories and refresh the internal cache.

        Skips the scan if no directory has been modified since the last call
        (unless *force* is True). Directories are scanned in order; on a name
        collision, the first match wins (so app-local skills shadow user-global
        ones with the same name).
        """
        if not force:
            try:
                newest = max(
                    (d.stat().st_mtime for d in self.skills_dirs if d.exists()),
                    default=0.0,
                )
                if newest <= self._last_scan_ts and self._skills:
                    return
            except OSError:
                pass

        self._skills.clear()
        for d in self.skills_dirs:
            if not d.exists():
                continue
            for skill_md in self._iter_skill_files(d):
                try:
                    text = skill_md.read_text("utf-8")
                except OSError:
                    continue
                meta, _ = _parse_frontmatter(text)
                entry_path = skill_md.parent
                name = meta.get("name") or entry_path.name
                if name in self._skills:
                    continue  # first match wins; avoids collisions across collections
                self._skills[name] = SkillEntry(
                    name=name,
                    description=meta.get("description", "").strip(),
                    version=meta.get("version", ""),
                    author=meta.get("author", ""),
                    path=entry_path,
                )
        self._last_scan_ts = time.time()

    def _iter_skill_files(self, root: Path) -> list[Path]:
        """Walk *root* yielding every SKILL.md, sorted by path; skip noise dirs."""
        results: list[Path] = []

        def walk(d: Path) -> None:
            try:
                children = sorted(d.iterdir())
            except OSError:
                return
            for c in children:
                if c.is_dir():
                    if c.name in self._SKIP_DIRS or c.name.startswith("."):
                        continue
                    walk(c)
                elif c.name == "SKILL.md":
                    results.append(c)

        walk(root)
        return results

    def list_skills(self) -> list[SkillEntry]:
        return sorted(self._skills.values(), key=lambda s: s.name)

    def get(self, name: str) -> SkillEntry | None:
        return self._skills.get(name)

    def list_names(self) -> list[str]:
        return sorted(self._skills.keys())

    def find_skill_md(self, name: str) -> Path | None:
        entry = self._skills.get(name)
        if entry is None:
            return None
        path = entry.path / "SKILL.md"
        return path if path.is_file() else None

    def render_prompt(self) -> str:
        if not self._skills:
            return ""
        lines = [
            f"- **{e.name}**: {e.description}" if e.description else f"- **{e.name}**"
            for e in self.list_skills()
        ]
        return self._PROMPT_TEMPLATE.format(descriptions="\n".join(lines))
