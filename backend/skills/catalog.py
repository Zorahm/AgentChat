"""Curated Anthropic skills catalog.

We deliberately surface only a hand-picked subset of ``anthropics/skills``:
the four document skills (Word/Excel/PowerPoint/PDF) plus frontend-design.
Everything else in that repo (mcp-builder, slack-gif-creator, canvas-design,
…) is noise for this app and is filtered out both in the per-skill catalog
install and as a safeguard when the whole repo is installed via the URL box.

The UI owns presentation (labels, icons, descriptions) keyed by ``key``; this
module owns only *where to fetch each skill from*.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CuratedSkill:
    key: str  # install folder name + UI catalog key
    repo: str  # GitHub 'owner/repo'
    subdir: str  # path to the skill folder inside the repo


ANTHROPIC_SOURCE = "anthropics/skills"

CURATED_SKILLS: tuple[CuratedSkill, ...] = (
    CuratedSkill("docx", ANTHROPIC_SOURCE, "skills/docx"),
    CuratedSkill("xlsx", ANTHROPIC_SOURCE, "skills/xlsx"),
    CuratedSkill("pptx", ANTHROPIC_SOURCE, "skills/pptx"),
    CuratedSkill("pdf", ANTHROPIC_SOURCE, "skills/pdf"),
    CuratedSkill("frontend-design", ANTHROPIC_SOURCE, "skills/frontend-design"),
)

CURATED_BY_KEY: dict[str, CuratedSkill] = {s.key: s for s in CURATED_SKILLS}

# Skill-folder basenames we keep when the whole anthropics/skills repo is
# installed at once. Used by the installer to prune the rest.
ANTHROPIC_ALLOWED_DIR_NAMES: frozenset[str] = frozenset(
    s.subdir.rsplit("/", 1)[-1] for s in CURATED_SKILLS
)
