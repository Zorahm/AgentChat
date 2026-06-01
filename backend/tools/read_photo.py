"""Read photo tool — loads an image and passes it to the LLM as a vision block."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from agent.sandbox import SandboxPolicy
from agent.wsl_exec import wsl_read_bytes
from tools.base import BaseTool, ToolDefinition, ToolSchema

_MIME_MAP: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
}

MAX_BYTES = 20_000_000  # 20 MB hard cap


class ReadPhotoTool(BaseTool):
    """Read an image file and return it as a vision content block for the LLM."""

    name = "read_photo"
    description = (
        "Read an image file and pass it directly to the model as a vision input. "
        "Use this when you need to see the actual pixel content of an image — "
        "e.g. to describe it, extract text, or analyse its contents. "
        "Accepts an absolute path (Windows or WSL). "
        "Supported formats: jpg, jpeg, png, gif, webp, bmp, svg."
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
                            "description": "Absolute path to the image file.",
                        },
                    },
                    "required": ["path"],
                },
            )
        )

    async def execute(self, path: str) -> str | list[dict[str, Any]]:  # type: ignore[override]
        denied = self._policy.check_read(path)
        if denied:
            return f"Error: {denied}"

        suffix = Path(path).suffix.lower()
        media_type = _MIME_MAP.get(suffix)
        if media_type is None:
            return (
                f"Error: unsupported image format '{suffix}'. "
                f"Supported: {', '.join(_MIME_MAP)}"
            )

        try:
            if path.startswith("/"):
                data = await wsl_read_bytes(path)
            else:
                file_path = Path(path)
                if not file_path.exists():
                    return f"Error: file not found — {path}"
                if not file_path.is_file():
                    return f"Error: not a regular file — {path}"
                data = file_path.read_bytes()
        except FileNotFoundError:
            return f"Error: file not found — {path}"
        except OSError as e:
            return f"Error reading file: {e}"

        if len(data) > MAX_BYTES:
            return f"Error: image too large ({len(data)} bytes, max {MAX_BYTES})"

        b64 = base64.b64encode(data).decode("ascii")
        return [
            {
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{b64}"},
            }
        ]
