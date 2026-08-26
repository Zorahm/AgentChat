"""Skill discovery inside a plugin — Agent Plugins §6 and §7.1.

The fixed location is ``skills/``, and discovery stops at its immediate
children: exactly one skill per child directory holding a regular ``SKILL.md``.
The spec forbids searching deeper, which is the one place this differs from
:class:`~skills.reader.AgentSkillsReader` — that walks a whole tree, because
``~/.agents/skills/`` is a collection people nest by hand.

The skill *format* is not defined here. Agent Skills owns ``SKILL.md``; this
module only decides what counts as a discovered skill and skips the ones that
cannot be one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from plugins.safety import is_within
from schemas.plugins import SKILLS_DIR_NAME, PluginIssue
from skills.reader import SkillEntry, _parse_frontmatter


@dataclass(frozen=True)
class SkillDiscoveryResult:
    skills: tuple[SkillEntry, ...] = ()
    issues: tuple[PluginIssue, ...] = ()


def _error(message: str, target: str | None = None) -> PluginIssue:
    return PluginIssue(level="error", scope="skill", message=message, target=target)


def _warning(message: str, target: str | None = None) -> PluginIssue:
    return PluginIssue(level="warning", scope="skill", message=message, target=target)


def discover_skills(plugin_root: Path, plugin_name: str = "") -> SkillDiscoveryResult:
    """Find every skill in ``<plugin_root>/skills/``.

    *plugin_name* is stamped onto each entry so the shared skills index — and
    through it the system prompt — can say which package a skill came from.
    """
    skills_dir = plugin_root / SKILLS_DIR_NAME
    if not skills_dir.exists():
        return SkillDiscoveryResult()  # §6.2 — absent is not an error
    if not skills_dir.is_dir():
        return SkillDiscoveryResult(
            issues=(_error(f"'{SKILLS_DIR_NAME}' is not a directory"),)
        )

    try:
        children = sorted(p for p in skills_dir.iterdir() if p.is_dir())
    except OSError as exc:
        return SkillDiscoveryResult(issues=(_error(f"Cannot list '{SKILLS_DIR_NAME}': {exc}"),))

    skills: list[SkillEntry] = []
    issues: list[PluginIssue] = []
    for child in children:
        entry, child_issues = _read_skill(plugin_root, child, plugin_name)
        issues.extend(child_issues)
        if entry is not None:
            skills.append(entry)
    return SkillDiscoveryResult(tuple(skills), tuple(issues))


def _read_skill(
    plugin_root: Path, skill_dir: Path, plugin_name: str
) -> tuple[SkillEntry | None, list[PluginIssue]]:
    """Validate one candidate skill directory."""
    name = skill_dir.name
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        # Not a skill at all rather than a broken one — a plugin may keep
        # shared assets beside its skills, and saying so on every load would
        # be noise.
        return None, []
    # §4.1 — a symlinked SKILL.md may point within the package but never out
    # of it.
    if not is_within(plugin_root, skill_md):
        return None, [_error("SKILL.md resolves outside the plugin", target=name)]

    try:
        text = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, [_error(f"Cannot read SKILL.md: {exc}", target=name)]

    meta, _ = _parse_frontmatter(text)
    skill_name = (meta.get("name") or "").strip()
    description = (meta.get("description") or "").strip()
    if not skill_name or not description:
        # Agent Skills requires both; without them the model has no way to
        # decide when the skill applies, so loading it would be worse than
        # skipping it.
        return None, [
            _error("SKILL.md frontmatter needs both 'name' and 'description'", target=name)
        ]

    issues: list[PluginIssue] = []
    if skill_name != name:
        issues.append(
            _warning(f"Skill declares name {skill_name!r} but lives in {name!r}", target=name)
        )

    return (
        SkillEntry(
            name=skill_name,
            description=description,
            version=(meta.get("version") or "").strip(),
            author=(meta.get("author") or "").strip(),
            path=skill_dir,
            plugin=plugin_name,
        ),
        issues,
    )
