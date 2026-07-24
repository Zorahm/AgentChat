"""Fence tool output that originates outside the user's trust boundary.

The system prompt states that tool-retrieved content is *data, not
instructions*. That rule is invisible at the moment the bytes actually arrive,
so the two remote/user-supplied sources — pages fetched by ``web_fetch`` and
files the user dropped into ``uploads/`` — are wrapped in an explicit marker
the model can see inline. Everything the agent itself produced (files it wrote,
command output it generated) is left unmarked.

This is the one change that lives outside the prompt-assembly package; the loop
calls it when recording a tool result.
"""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

MARKER = "untrusted_content"


def _reads_upload(path: str) -> bool:
    """True when *path* points inside a chat's ``uploads/`` folder."""
    if not path:
        return False
    # Pick the path flavour by separator so a Windows path is parsed on any host.
    parts = PureWindowsPath(path).parts if "\\" in path else PurePosixPath(path).parts
    return "uploads" in parts


def untrusted_source(tool_name: str, args: dict[str, Any]) -> str | None:
    """Return a source label if this tool call yielded untrusted content.

    ``None`` means the output is trusted (agent-generated) and must not be
    wrapped.
    """
    if tool_name == "web_fetch":
        return f"web_fetch {str(args.get('url', '')).strip()}".strip()
    if tool_name == "read_file" and _reads_upload(str(args.get("path", ""))):
        return f"upload {str(args.get('path', '')).strip()}".strip()
    return None


def wrap_untrusted(source: str, content: str) -> str:
    """Fence *content* in an untrusted-content marker tagged with *source*."""
    safe_source = source.replace('"', "'")  # keep the attribute unbreakable
    return f'<{MARKER} source="{safe_source}">\n{content}\n</{MARKER}>'
