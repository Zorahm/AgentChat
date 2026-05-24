"""Read file tool — reads content from the local filesystem."""

from __future__ import annotations

from pathlib import Path

from agent.sandbox import SandboxPolicy
from agent.wsl_exec import wsl_read_text
from tools.base import BaseTool, ToolDefinition, ToolSchema

MAX_BYTES = 100_000


class ReadFileTool(BaseTool):
    """Read the contents of a file at the given path."""

    name = "read_file"
    description = (
        "Read the contents of a file on the local filesystem. "
        "Accepts an absolute path. Returns file contents as a string. "
        "For large files, use offset (1-based line number to start from) and "
        "limit (max lines to return) to read in chunks."
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
                            "description": "Absolute path to the file to read.",
                        },
                        "offset": {
                            "type": "integer",
                            "description": (
                                "1-based line number to start reading from. "
                                "Defaults to 1 (start of file)."
                            ),
                        },
                        "limit": {
                            "type": "integer",
                            "description": (
                                "Maximum number of lines to return. "
                                "Defaults to the whole file (or MAX_BYTES)."
                            ),
                        },
                    },
                    "required": ["path"],
                },
            )
        )

    async def execute(self, path: str, offset: int = 1, limit: int = 0) -> str:
        """Read the file at *path* and return its content."""
        denied = self._policy.check_read(path)
        if denied:
            return f"Error: {denied}"

        if path.startswith("/"):
            try:
                content = await wsl_read_text(path)
            except FileNotFoundError:
                return f"Error: file not found — {path}"
            except OSError as e:
                return f"Error reading file: {e}"
        else:
            file_path = Path(path)
            if not file_path.exists():
                return f"Error: file not found — {path}"
            if not file_path.is_file():
                return f"Error: not a regular file — {path}"
            try:
                content = file_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                return f"Error: file is not valid UTF-8 — {path}"
            except OSError as e:
                return f"Error reading file: {e}"

        total_lines = content.count("\n") + (1 if not content.endswith("\n") else 0)
        effective_offset = max(offset, 1)

        if limit > 0 or effective_offset > 1:
            lines = content.splitlines(keepends=True)
            start = effective_offset - 1
            if start >= len(lines):
                return (
                    f"Error: offset {effective_offset} exceeds total lines ({len(lines)}) "
                    f"in {path}"
                )
            end = start + limit if limit > 0 else len(lines)
            selected = lines[start:end]
            result = "".join(selected)
            header = (
                f"[Lines {effective_offset}–{min(effective_offset + len(selected) - 1, len(lines))} "
                f"of {len(lines)} in {path}]"
            )
            if len(result.encode("utf-8")) > MAX_BYTES:
                truncated = result[:MAX_BYTES]
                return (
                    f"{header}\n\n"
                    f"[Truncated — showing ~{MAX_BYTES} bytes of this chunk]\n\n"
                    + truncated
                )
            return f"{header}\n\n{result}"

        if len(content) > MAX_BYTES:
            total_size = len(content)
            preview = content[:MAX_BYTES]
            preview_lines = preview.count("\n")
            return (
                f"[File: {path} — {total_lines} lines, {total_size} bytes]\n"
                f"[Showing first {preview_lines} lines. "
                f"Use offset/limit to read more.]\n\n"
                + preview
            )
        return content
