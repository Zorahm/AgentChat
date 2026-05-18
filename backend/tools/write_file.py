"""Write file tool — writes or appends content to the local filesystem."""

from __future__ import annotations

from pathlib import Path

from agent.wsl_exec import wsl_write_bytes
from tools.base import BaseTool, ToolDefinition, ToolSchema


class WriteFileTool(BaseTool):
    """Write or append content to a file on the local filesystem."""

    name = "write_file"
    description = (
        "Write or append content to a file on the local filesystem. "
        "Use append=true to add content to an existing file without overwriting it. "
        "For files longer than 60 lines, split into multiple calls: "
        "first call with append=false (creates/overwrites), subsequent calls with append=true."
    )

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
                            "description": "Absolute path where the file should be written.",
                        },
                        "content": {
                            "type": "string",
                            "description": (
                                "The text content to write. "
                                "Keep each call under ~60 lines; use append=true for continuation."
                            ),
                        },
                        "append": {
                            "type": "boolean",
                            "description": (
                                "If true, append content to the existing file instead of overwriting. "
                                "Defaults to false."
                            ),
                            "default": False,
                        },
                    },
                    "required": ["path", "content"],
                },
            )
        )

    async def execute(self, path: str, content: str, append: bool = False) -> str:
        """Write or append *content* to the file at *path*."""
        if path.startswith("/"):
            try:
                await wsl_write_bytes(path, content.encode("utf-8"), append=append)
            except OSError as e:
                return f"Error writing file: {e}"
            action = "Appended" if append else "Written"
            return f"{action} to {path} ({len(content.encode())} bytes)"

        # Windows path
        file_path = Path(path)
        try:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            mode = "a" if append else "w"
            with file_path.open(mode, encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            return f"Error writing file: {e}"

        size = file_path.stat().st_size
        action = "Appended" if append else "Written"
        return f"{action} to {path} ({size} bytes total)"
