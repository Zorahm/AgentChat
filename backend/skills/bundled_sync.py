"""Keep installed bundled skills in step with the ones shipped in the app.

``install_local`` copies a bundled skill (the office four + ``agentchat``) into
``~/.agents/skills/`` once. Without this module that copy is frozen forever: a
new app version ships a rewritten SKILL.md and every existing user keeps reading
the old one, with no signal that anything changed.

So at startup we compare a *content fingerprint* of each bundled skill against
the one recorded in its install marker, and re-copy when they differ.

Fingerprint rather than app version, because the two disagree exactly where it
matters: in development the version never moves while the skills are being
edited, and a release that doesn't touch skills shouldn't churn them. Content is
the thing the user actually reads, so content is what the check follows.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from skills.catalog import CURATED_SKILLS
from skills.fingerprint import fingerprint
from skills.installer import GitHubSkillInstaller, read_marker

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SyncResult:
    """What one startup sweep did — logged, and handy in tests."""

    updated: tuple[str, ...] = ()
    #: Installed skills a user has edited by hand; left untouched on purpose.
    skipped_modified: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()


def sync_bundled_skills(
    installer: GitHubSkillInstaller,
    bundled_root: Path | None,
) -> SyncResult:
    """Refresh every *already installed* bundled skill whose content changed.

    Deliberately does not install anything new: a skill the user never picked
    appearing on its own after an update is a surprise, not a feature. Only the
    folders they already chose are brought up to date.
    """
    if bundled_root is None or not bundled_root.is_dir():
        return SyncResult()

    updated: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []

    for curated in CURATED_SKILLS:
        if not curated.local_subdir:
            continue
        source = bundled_root / curated.local_subdir
        dest = installer.skills_dir / curated.key
        if not source.is_dir() or not dest.is_dir():
            continue
        marker = read_marker(dest)
        # Only ours, and only this bundled skill's own folder.
        if marker.get("source") != f"bundled:{curated.key}":
            continue

        recorded = marker.get("content", "")
        if recorded and fingerprint(source) == recorded:
            continue  # already current

        # A marker written before this feature existed has no fingerprint, so
        # there is no baseline to detect user edits against — refresh anyway,
        # since those stale copies are the whole reason this runs.
        if recorded and fingerprint(dest) != recorded:
            skipped.append(curated.key)
            continue

        try:
            installer.install_local(source, curated.key)
            updated.append(curated.key)
        except Exception as exc:  # noqa: BLE001 — one bad skill must not stop startup
            logger.warning("Could not refresh bundled skill %r: %s", curated.key, exc)
            failed.append(curated.key)

    if updated:
        logger.info("Refreshed bundled skills: %s", ", ".join(updated))
    if skipped:
        logger.info("Kept locally modified skills as-is: %s", ", ".join(skipped))
    return SyncResult(tuple(updated), tuple(skipped), tuple(failed))
