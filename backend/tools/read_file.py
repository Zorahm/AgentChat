"""Read file tool — reads content from the local filesystem."""

from __future__ import annotations

from pathlib import Path

from agent.sandbox import SandboxPolicy
from tools.base import BaseTool, ToolDefinition, ToolSchema

MAX_BYTES = 100_000


class ReadFileTool(BaseTool):
    """Read the contents of a file at the given path."""

    name = "read_file"
    description = (
        "Read the contents of a file on the local filesystem. "
        "Accepts an absolute path. Returns file contents as a string."
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
                        }
                    },
                    "required": ["path"],
                },
            )
        )

    async def execute(self, path: str) -> str:
        """Read the file at *path* and return its content."""
        denied = self._policy.check_read(path)
        if denied:
            return f"Error: {denied}"

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

        if len(content) > MAX_BYTES:
            preview = content[:MAX_BYTES]
            return (
                f"[Truncated — {len(content)} bytes total, showing first {MAX_BYTES}]\n\n"
                + preview
            )
        return content
