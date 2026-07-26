"""Masking of secret-bearing maps on the way out of the API.

``extra_headers`` and MCP ``env`` / ``headers`` hold user-defined keys, so the
backend cannot tell an auth token from a harmless variable and masks every
value. Key names stay visible — the user needs to see what is configured.

A write that sends :data:`MASK` back means "keep what is stored". That is what
lets the existing full-replacement editors in the UI round-trip untouched rows
without any frontend change: they load masked values and hand them straight
back on save.
"""

from __future__ import annotations

from collections.abc import Mapping

MASK = "•" * 8


def redact_map(values: Mapping[str, str] | None) -> dict[str, str] | None:
    """Replace every value with :data:`MASK`, keeping the keys."""
    if values is None:
        return None
    return {k: MASK for k in values}


def unredact_map(
    incoming: Mapping[str, str] | None,
    stored: Mapping[str, str] | None,
) -> dict[str, str] | None:
    """Resolve :data:`MASK` placeholders in *incoming* against *stored*.

    A masked entry whose key is missing from *stored* resolves to an empty
    string rather than vanishing: the user cannot have typed MASK, so the only
    way to reach that state is a stale form, and a visibly empty value is
    easier to notice than a silently dropped one.
    """
    if incoming is None:
        return None
    known = stored or {}
    return {k: (known.get(k, "") if v == MASK else v) for k, v in incoming.items()}
