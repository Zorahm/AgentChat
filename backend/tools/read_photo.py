"""Read photo tool — loads an image and passes it to the LLM as a vision block."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from agent.sandbox import SandboxPolicy
from agent.host_exec import host_read_bytes
from tools.base import BaseTool, ToolDefinition, ToolSchema

# Exactly the four formats the vision APIs decode. Anything else has to be
# converted first — sending it as a data URL doesn't degrade gracefully, it
# fails the whole request with a provider 400 that reads like a model error.
_MIME_MAP: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

# Formats that look like images but aren't accepted as vision input, each with
# the route that does work. Listed rather than lumped into "unsupported"
# because both have an obvious answer the model can act on immediately.
_CONVERTIBLE: dict[str, str] = {
    ".svg": (
        "SVG is markup, not pixels — no vision API decodes it. Read it as text "
        "with read_file, or rasterise it to PNG first (bash_tool: rsvg-convert / "
        "inkscape / cairosvg)."
    ),
    ".bmp": (
        "BMP is not accepted as vision input. Convert it to PNG first "
        "(bash_tool: magick in.bmp out.png)."
    ),
    ".tif": "TIFF is not accepted as vision input. Convert it to PNG first.",
    ".tiff": "TIFF is not accepted as vision input. Convert it to PNG first.",
    ".heic": "HEIC is not accepted as vision input. Convert it to JPEG first.",
}

# Providers cap a single image at about 5 MB, and base64 inflates it by a third
# on the way out. A larger file has to be downscaled, not sent and rejected.
MAX_BYTES = 5_000_000


class ReadPhotoTool(BaseTool):
    """Read an image file and return it as a vision content block for the LLM."""

    name = "read_photo"
    description = (
        "Read an image file and pass it directly to the model as a vision input. "
        "Use this when you need to see the actual pixel content of an image — "
        "e.g. to describe it, extract text, or analyse its contents. "
        "Accepts an absolute path (Windows or WSL), or one relative to the chat "
        "folder. Supported formats: jpg, jpeg, png, gif, webp — anything else "
        "has to be converted first, and the error will say how."
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
            route = _CONVERTIBLE.get(suffix)
            if route:
                return f"Error: {route}"
            return (
                f"Error: unsupported image format '{suffix}'. "
                f"Supported: {', '.join(_MIME_MAP)}"
            )

        try:
            if path.startswith("/"):
                # Bounded so a mislabelled 2 GB file can't be pulled through the
                # wsl.exe pipe in full just to fail the size check afterwards.
                data = await host_read_bytes(path, max_bytes=MAX_BYTES + 1)
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
            return (
                f"Error: image is larger than the {MAX_BYTES // 1_000_000} MB a vision "
                f"request accepts. Downscale it first (bash_tool: "
                f"magick {Path(path).name} -resize 2000x2000\\> small.png), then read that."
            )

        b64 = base64.b64encode(data).decode("ascii")
        return [
            {
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{b64}"},
            }
        ]
