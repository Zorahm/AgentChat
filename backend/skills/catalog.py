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
    # When set, the skill is bundled with the app and installs offline from a
    # local copy: this is its folder name inside the bundled skills root (see
    # ``paths.resolve_bundled_skills``). GitHub remains the fallback.
    local_subdir: str | None = None


ANTHROPIC_SOURCE = "anthropics/skills"
# Anthropic's own SKILL.md files don't self-attribute an `author` field (unlike
# our bundled/adapted copies, which say "AgentChat") — see installer.py's
# _ensure_author_field, used when a curated skill installs unmodified from GitHub.
ANTHROPIC_DISPLAY_NAME = "Anthropic"

# The office four + ``agentchat`` are our own bundled skills (repo ``skills/``),
# so they install from the local copy. frontend-design is installed straight from
# GitHub, unmodified. ``agentchat`` is local-only (it describes this app) — the
# GitHub repo/subdir below is a never-used fallback placeholder.
CURATED_SKILLS: tuple[CuratedSkill, ...] = (
    CuratedSkill("agentchat", ANTHROPIC_SOURCE, "skills/agentchat", local_subdir="agentchat"),
    CuratedSkill("docx", ANTHROPIC_SOURCE, "skills/docx", local_subdir="docx"),
    CuratedSkill("xlsx", ANTHROPIC_SOURCE, "skills/xlsx", local_subdir="xlsx"),
    CuratedSkill("pptx", ANTHROPIC_SOURCE, "skills/pptx", local_subdir="pptx"),
    CuratedSkill("pdf", ANTHROPIC_SOURCE, "skills/pdf", local_subdir="pdf"),
    CuratedSkill("frontend-design", ANTHROPIC_SOURCE, "skills/frontend-design"),
)

CURATED_BY_KEY: dict[str, CuratedSkill] = {s.key: s for s in CURATED_SKILLS}

# Skill-folder basenames we keep when the whole anthropics/skills repo is
# installed at once. Used by the installer to prune the rest.
ANTHROPIC_ALLOWED_DIR_NAMES: frozenset[str] = frozenset(
    s.subdir.rsplit("/", 1)[-1] for s in CURATED_SKILLS
)
