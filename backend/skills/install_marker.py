"""The ``.agentchat-installed`` marker — proof that a folder is ours to touch.

``~/.agents/`` is a shared tree: Claude Code and other agent systems plant
skills there too, and a user may drop one in by hand. The marker is how an
uninstall tells apart a directory this app created from one it merely found,
so DELETE never removes something it did not install.

A leaf shared by the skills installer and the plugins installer — both write
into shared trees and both need the same answer to "did we put this here?".
"""

from __future__ import annotations

from pathlib import Path

from _buildstamp import BUILD_VERSION

MARKER_NAME = ".agentchat-installed"


def read_marker(directory: Path) -> dict[str, str]:
    """Parse a marker into ``key=value`` pairs.

    Returns ``{}`` both for a folder we never installed and for an unreadable
    marker — callers treat the two the same: not ours to touch.
    """
    try:
        text = (directory / MARKER_NAME).read_text(encoding="utf-8")
    except OSError:
        return {}
    fields: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            fields[key.strip()] = value.strip()
    return fields


def write_marker(dest: Path, source: str, content: str = "") -> None:
    """Record who installed *dest*, from where, and optionally its fingerprint.

    Best-effort: the install itself has already succeeded by the time this
    runs, and a missing marker costs an uninstall prompt, not correctness.
    """
    lines = ["installed-by=agentchat", f"source={source}", f"version={BUILD_VERSION}"]
    if content:
        # Fingerprint of what was installed — bundled_sync compares it against
        # the shipped copy to spot both a new release's content and a folder
        # the user has since edited.
        lines.append(f"content={content}")
    try:
        (dest / MARKER_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def has_marker_above(path: Path, root: Path) -> bool:
    """True iff a marker sits at *path* or any parent up to *root* inclusive.

    Walking upward matters because one install can produce several skills: a
    repo install marks the repo folder, not each ``SKILL.md`` beside it.
    """
    try:
        target = path.resolve()
        root_resolved = root.resolve()
        target.relative_to(root_resolved)
    except (ValueError, OSError):
        return False
    current = target
    while True:
        if (current / MARKER_NAME).is_file():
            return True
        if current == root_resolved:
            return False
        current = current.parent
