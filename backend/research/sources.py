"""Source-URL handling: extraction, de-duplication, and citation auditing.

The run collects every URL any agent actually searched up or fetched. That set is
what the citation audit checks the finished report against — a ``[n]`` pointing at
a URL nobody opened is the signature of a fabricated citation, and the reader
deserves to be told rather than have the report silently rewritten.
"""

from __future__ import annotations

import re

_URL_RE = re.compile(r"https?://[^\s)\]<>\"']+")
_TRAILING = ".,;:)]}\"'"


def extract_urls(text: str) -> list[str]:
    """Pull unique URLs out of a text blob (order-preserving)."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in _URL_RE.findall(text):
        url = raw.rstrip(_TRAILING)
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def dedupe(urls: list[str]) -> list[str]:
    """Order-preserving de-duplication."""
    out: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _key(url: str) -> str:
    """Comparison key: scheme, ``www.`` and a trailing slash don't make it a new source."""
    body = re.sub(r"^https?://", "", url.strip(), flags=re.IGNORECASE)
    body = re.sub(r"^www\.", "", body, flags=re.IGNORECASE)
    return body.rstrip("/").lower()


def audit_citations(report: str, known_urls: list[str]) -> list[str]:
    """Return human-readable warnings about the report's sources.

    Flags URLs cited in the report that no agent in this run actually visited.
    Never edits the report — a silent fix would hide exactly the failure the
    reader needs to see.
    """
    if not known_urls:
        return []
    visited = {_key(u) for u in known_urls}
    unseen = [u for u in extract_urls(report) if _key(u) not in visited]
    if not unseen:
        return []
    shown = ", ".join(unseen[:5])
    more = f" (+{len(unseen) - 5} more)" if len(unseen) > 5 else ""
    return [f"{len(unseen)} cited URL(s) were never opened during this run: {shown}{more}"]
