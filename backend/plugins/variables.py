"""Plugin variables and derived identifiers — Agent Plugins §9.2.

Two placeholders exist and no others: ``${PLUGIN_ROOT}`` (the package) and
``${PLUGIN_DATA}`` (client-managed writable state that survives an update).
Everything that *looks* like a placeholder stays literal, and no other
environment-variable expansion happens at all — a plugin cannot reach the
client's own environment by writing ``${HOME}``.

A leaf: standard library only.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

# Matched in one pass by ``re.sub`` so a replacement's own text is never
# rescanned: ``${PLUGIN_ROOT}`` expanding to a directory that happens to
# contain the literal text ``${PLUGIN_DATA}`` must not expand a second time.
_PLACEHOLDER_RE = re.compile(r"\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}")

# The client's own id scheme for a plugin's MCP servers. `mcp.json` names its
# servers with arbitrary JSON keys, while MCPServerConfig.id is a slug — so the
# id is derived, and the original key travels alongside it for display.
_ID_PREFIX = "p-"
_ID_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ID_SLUG_MAX = 50
_ID_DIGEST_LEN = 8


def expand(value: str, plugin_root: Path, plugin_data: Path) -> str:
    """Replace both plugin variables in *value*, once, leaving the rest alone."""
    roots = {"PLUGIN_ROOT": str(plugin_root), "PLUGIN_DATA": str(plugin_data)}
    return _PLACEHOLDER_RE.sub(lambda m: roots[m.group(1)], value)


def plugin_server_id(plugin_name: str, server_key: str) -> str:
    """Derive a stable ``MCPServerConfig.id`` for one plugin server entry.

    Readable where the names allow it, and unique regardless: the digest is
    taken over both names, so two plugins whose server keys slugify the same
    still get different ids. The result always satisfies the id slug pattern
    (lowercase alphanumerics plus ``-``, ≤ 64 chars, alphanumeric first char).
    """
    digest = hashlib.sha256(f"{plugin_name}\0{server_key}".encode()).hexdigest()[:_ID_DIGEST_LEN]
    slug = _ID_SLUG_RE.sub("-", f"{plugin_name}-{server_key}".lower()).strip("-")
    slug = slug[:_ID_SLUG_MAX].strip("-")
    return f"{_ID_PREFIX}{slug}-{digest}" if slug else f"{_ID_PREFIX}{digest}"


def is_plugin_server_id(server_id: str) -> bool:
    """True iff *server_id* was minted by :func:`plugin_server_id`.

    Only a hint for the UI and for import guards — the registry is the
    authority on which servers a plugin actually owns.
    """
    return server_id.startswith(_ID_PREFIX)
