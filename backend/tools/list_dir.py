"""List directory tool — see what is in a folder without shelling out."""

from __future__ import annotations

import fnmatch
from typing import Any

from agent.dir_listing import DirEntry
from agent.host_exec import host_list_dir
from agent.sandbox import SandboxPolicy
from tools.arg_coerce import clamp_int
from tools.base import BaseTool, ToolDefinition, ToolSchema

MAX_ENTRIES = 500
MAX_DEPTH = 5

# Directories that are never worth walking into: enormous, machine-generated,
# and never what the user meant. Listed at their own level, just not descended
# into — the model can still point `path` straight at one.
NOISE_DIRS: frozenset[str] = frozenset(
    {".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache", ".ruff_cache"}
)


class ListDirTool(BaseTool):
    """List the entries of a directory, optionally a few levels deep."""

    name = "list_dir"
    description = (
        "List what is inside a directory: names, sizes and which entries are "
        "folders. Use it to look around before reading files — it is cheaper and "
        "clearer than running `ls` through bash. Omit `path` to list the chat's "
        "working folder. `depth` walks subfolders (1 = this folder only, max 5); "
        "`pattern` keeps only entries whose name matches a glob such as '*.py'."
    )

    def __init__(self) -> None:
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "Absolute path of the directory to list. "
                                "Defaults to the chat's working folder."
                            ),
                        },
                        "depth": {
                            "type": "integer",
                            "description": (
                                f"How many levels to walk: 1 lists this folder only "
                                f"(default), {MAX_DEPTH} is the maximum."
                            ),
                        },
                        "pattern": {
                            "type": "string",
                            "description": (
                                "Optional glob matched against entry names, e.g. "
                                "'*.py'. Matching entries are listed by full "
                                "relative path instead of as a tree."
                            ),
                        },
                    },
                    "required": [],
                },
            )
        )

    async def execute(self, path: str = "", depth: Any = 1, pattern: str = "") -> str:
        """List *path* (or the chat folder) and render it for the model."""
        target = (path or "").strip() or self._policy.chat_dir
        if not target:
            return (
                "Error: no directory to list — this chat has no working folder. "
                "Pass an absolute path."
            )

        denied = self._policy.check_read(target)
        if denied:
            return f"Error: {denied}"

        levels = _clamp_depth(depth)
        try:
            entries = await host_list_dir(target, depth=levels, skip=NOISE_DIRS)
        except FileNotFoundError:
            return f"Error: directory not found — {target}"
        except NotADirectoryError:
            return f"Error: not a directory — {target}. Use read_file to read a file."
        except OSError as e:
            return f"Error listing directory: {e}"

        return _render(target, entries, levels, (pattern or "").strip())


def _clamp_depth(depth: Any) -> int:
    """Coerce a model-supplied depth into 1..MAX_DEPTH."""
    return clamp_int(depth, fallback=1, low=1, high=MAX_DEPTH)


def _render(target: str, entries: list[DirEntry], depth: int, pattern: str) -> str:
    """Format entries as an indented tree, or a flat list when filtering."""
    if pattern:
        entries = [e for e in entries if fnmatch.fnmatch(_name(e.rel).lower(), pattern.lower())]

    total = len(entries)
    if total == 0:
        what = f"nothing matching '{pattern}'" if pattern else "empty"
        return f"[{target} — {what}]"

    entries = sorted(entries, key=_sort_key)
    shown = entries[:MAX_ENTRIES]

    lines = [_flat_line(e) if pattern else _tree_line(e) for e in shown]

    head = f"[{target} — {total} entries"
    if depth > 1:
        head += f", depth {depth}"
    if pattern:
        head += f", matching '{pattern}'"
    head += "]"

    parts = [head, "", "\n".join(lines)]
    if total > len(shown):
        parts.append(
            f"\n[Truncated — {len(shown)} of {total} entries shown. "
            f"Narrow it with a pattern, or list a subfolder directly.]"
        )
    if depth > 1 and not pattern:
        skipped = sorted({_name(e.rel) for e in shown if e.is_dir and _name(e.rel) in NOISE_DIRS})
        if skipped:
            parts.append(
                f"\n[Not descended into: {', '.join(skipped)}. "
                f"Pass one as `path` to look inside.]"
            )
    return "\n".join(parts)


def _name(rel: str) -> str:
    return rel.rsplit("/", 1)[-1]


def _sort_key(entry: DirEntry) -> tuple[tuple[int, str], ...]:
    """Directories before files, alphabetical, children right after their parent.

    Every path segment but the last names a directory, so only the final one
    depends on the entry's own type. Comparing segment-wise (rather than the
    whole string) is what keeps a subtree contiguous.
    """
    parts = entry.rel.split("/")
    last = len(parts) - 1
    return tuple(
        (0 if (i < last or entry.is_dir) else 1, part.lower()) for i, part in enumerate(parts)
    )


def _tree_line(entry: DirEntry) -> str:
    indent = "  " * entry.rel.count("/")
    if entry.is_dir:
        return f"{indent}{_name(entry.rel)}/"
    return f"{indent}{_name(entry.rel)}  {_human_size(entry.size)}"


def _flat_line(entry: DirEntry) -> str:
    if entry.is_dir:
        return f"{entry.rel}/"
    return f"{entry.rel}  {_human_size(entry.size)}"


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"
