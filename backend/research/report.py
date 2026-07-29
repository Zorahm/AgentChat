"""Where a finished report lands on disk, and under what name.

Every run gets its own file. The old fixed ``report.md`` meant a second research
run in the same chat silently overwrote the first one's report — including the
file the first report card still links to.
"""

from __future__ import annotations

import re
from pathlib import Path

from agent.host_exec import host_read_bytes
from agent.sandbox import SandboxPolicy
from tools.write_file import WriteFileTool, _resolve_write_path

_MAX_SLUG = 48
_MAX_ATTEMPTS = 50


def slugify(title: str) -> str:
    """File-name-safe slug, keeping non-Latin letters (titles are often Russian)."""
    cleaned = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE).strip()
    slug = re.sub(r"[\s_-]+", "-", cleaned).strip("-").lower()
    return slug[:_MAX_SLUG].rstrip("-")


async def _exists(path: str) -> bool:
    """Whether *path* exists in the chat's filesystem namespace.

    Mirrors ``ReadFileTool``'s dispatch: a POSIX-absolute path may live inside
    WSL and is unreachable through ``pathlib`` from a Windows host.
    """
    if path.startswith("/"):
        try:
            await host_read_bytes(path)
        except (FileNotFoundError, OSError):
            return False
        return True
    return Path(path).exists()


async def resolve_report_path(title: str, policy: SandboxPolicy) -> str:
    """An absolute, not-yet-taken path for this run's report.

    Absolute because the UI builds the file card from the path the model passes
    to ``present_files`` verbatim — a relative one resolves against the backend's
    cwd and 404s as "file unavailable".
    """
    base = f"research-{slugify(title)}" if slugify(title) else "research-report"
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        name = f"{base}.md" if attempt == 1 else f"{base}-{attempt}.md"
        resolved = _resolve_write_path(name, policy) or name
        if not await _exists(resolved):
            return resolved
    return _resolve_write_path(f"{base}-{_MAX_ATTEMPTS + 1}.md", policy) or f"{base}.md"


async def write_report(path: str, markdown: str, policy: SandboxPolicy) -> str:
    """Write the report through the canonical write path. Returns its message."""
    writer = WriteFileTool()
    writer.set_policy(policy)
    result = await writer.execute(path=path, content=markdown)
    return result if isinstance(result, str) else str(result)
