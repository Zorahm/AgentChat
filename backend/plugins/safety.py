"""Path containment for plugin packages — Agent Plugins §4.1.

Every file the client reads or executes on a plugin's behalf has to resolve
back inside that plugin's root. Symlinks, junctions and reparse points are
allowed to *exist* — they just may not point out of the package. That means
containment is decided on the fully resolved path, never on the string.

A leaf: the standard library and nothing else, so both discovery and the MCP
config translator can use it.
"""

from __future__ import annotations

from pathlib import Path

# §4.1 rule 4 — a configuration field defined as a plugin-relative path must
# say so explicitly. `data` is not the same as `./data`: the latter is a
# declared package path, the former is an unanchored string the spec refuses
# to guess about.
RELATIVE_PREFIX = "./"


def real(path: Path) -> Path:
    """Fully resolve *path*, tolerating a target that does not exist yet.

    ``strict=False`` matters for ``PLUGIN_DATA`` and for a ``cwd`` the plugin
    expects its own server to create: containment must be decidable before the
    directory is there.
    """
    try:
        return path.resolve()
    except OSError:
        # A resolution loop or an unreadable parent. Fall back to the
        # lexically-normalised form so the caller still gets a containment
        # decision rather than an exception.
        return Path(path.absolute().as_posix())


def is_within(root: Path, candidate: Path) -> bool:
    """True iff *candidate* resolves to *root* itself or something under it."""
    resolved_root = real(root)
    resolved = real(candidate)
    if resolved == resolved_root:
        return True
    try:
        resolved.relative_to(resolved_root)
        return True
    except ValueError:
        return False


def resolve_within(root: Path, candidate: Path) -> Path | None:
    """Resolve *candidate* and return it, or ``None`` if it escapes *root*."""
    resolved = real(candidate)
    return resolved if is_within(root, resolved) else None


def is_plugin_relative(value: str) -> bool:
    """True iff *value* uses the declared plugin-relative form (``./…``)."""
    return value.startswith(RELATIVE_PREFIX)


def resolve_relative(root: Path, value: str) -> Path | None:
    """Resolve a declared plugin-relative *value* (``./…``) against *root*.

    Returns ``None`` for anything that is not in the declared form, and for a
    path that escapes the root once resolved. Callers that also accept a
    ``${PLUGIN_DATA}``-rooted form (only ``cwd`` does) resolve that branch
    themselves, since its containment is judged against a different root.
    """
    if not is_plugin_relative(value):
        return None
    return resolve_within(root, root / value[len(RELATIVE_PREFIX) :])
