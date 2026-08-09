"""image_generate tool — turn a prompt into image files in the chat folder.

The model writes the prompt; a backend (local Stable Diffusion WebUI, local
ComfyUI, or a hosted API) renders it; this tool writes the bytes into the chat's
``images/`` folder and hands the absolute paths back. From there the model is
free to ``read_photo`` the result, ``present_files`` it, or process it with
``bash_tool`` — the tool takes no position on what happens next.

Progress and the finished paths stream live: the path is only known *after*
generation, so it cannot ride along in the tool call's arguments the way
``show_widget``'s HTML does. ``agent.loop`` drains ``progress_queue`` and
forwards each event as ``tool_progress`` (hence ``streams_progress``), which is
also what draws the image card in the chat.
"""

from __future__ import annotations

import asyncio
import base64
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from agent.host_exec import host_read_bytes, host_write_bytes
from agent.sandbox import SandboxPolicy
from images.config import (
    MAX_IMAGES,
    MAX_SIZE,
    MIN_SIZE,
    DEFAULT_SIZE,
    GeneratedImage,
    ImageGenConfig,
    ImageGenError,
    ImageGenResult,
    ImageRequest,
)
from images.progress import ImageProgressEmitter
from images.service import ImageGenService
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.write_file import _looks_windows_abs, _resolve_write_path

_SIZE_RE = re.compile(r"^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$")
_SLUG_KEEP = re.compile(r"[^a-z0-9]+")
_SOURCE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


class ImageGenerateTool(BaseTool):
    """Generate images from a prompt and save them into the chat folder."""

    name = "image_generate"
    description = (
        "Generate an image from a text prompt and save it into the chat folder. "
        "Write the prompt yourself, in English, as a dense visual description — "
        "subject, action, setting, composition, lighting, medium and style — "
        "rather than passing the user's words through unchanged. The finished "
        "image is shown to the user automatically and the absolute path comes "
        "back, so afterwards you can call read_photo on it to check how it "
        "turned out, present_files to give the user a download card, or process "
        "it with bash_tool. Pass input_image to edit or restyle an existing "
        "picture instead of making a new one. You can call this several times "
        "in one turn to render different prompts — each call gets its own card. "
        "Use `n` instead when you want variations of one prompt."
    )
    # Signals agent.loop to run execute() as a task and forward progress_queue
    # events as tool_progress while it runs.
    streams_progress = True

    def __init__(self, service: ImageGenService, config: ImageGenConfig) -> None:
        self._service = service
        self._config = config
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)
        self.progress_queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

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
                        "prompt": {
                            "type": "string",
                            "description": (
                                "What to draw, in English: subject, setting, composition, "
                                "lighting, medium and style. Be specific and visual."
                            ),
                        },
                        "negative_prompt": {
                            "type": "string",
                            "description": (
                                "What must NOT appear. Local backends only — hosted "
                                "models ignore it, so put exclusions in the prompt too."
                            ),
                        },
                        "input_image": {
                            "type": "string",
                            "description": (
                                "Absolute path (or a path relative to the chat folder) of "
                                "an existing image to edit or restyle instead of drawing "
                                "from scratch. The prompt then describes the desired result."
                            ),
                        },
                        "strength": {
                            "type": "number",
                            "description": (
                                "With input_image: how far to move away from it, 0.1 "
                                "(barely) to 0.9 (loosely inspired). Default 0.6."
                            ),
                        },
                        "size": {
                            "type": "string",
                            "description": (
                                "Pixel size as WIDTHxHEIGHT, e.g. 1024x1024 (square), "
                                "1344x768 (landscape), 768x1344 (portrait). Default 1024x1024."
                            ),
                        },
                        "n": {
                            "type": "integer",
                            "description": f"How many variations to render, 1-{MAX_IMAGES}. Default 1.",
                        },
                        "seed": {
                            "type": "integer",
                            "description": (
                                "Fixed seed for a reproducible result — pass the seed of an "
                                "earlier image to re-roll it with a tweaked prompt. Omit for random."
                            ),
                        },
                        "steps": {
                            "type": "integer",
                            "description": "Sampling steps (local backends only). Default ~25.",
                        },
                        "cfg_scale": {
                            "type": "number",
                            "description": (
                                "How strictly to follow the prompt (local backends only). "
                                "~7 is balanced; higher is more literal."
                            ),
                        },
                        "backend": {
                            "type": "string",
                            "enum": ["auto", "api", "a1111", "comfy"],
                            "description": (
                                "Which renderer to use. Leave unset — 'auto' picks the "
                                "configured one, preferring the user's local GPU."
                            ),
                        },
                    },
                    "required": ["prompt"],
                },
            )
        )

    async def execute(  # type: ignore[override]
        self,
        prompt: str = "",
        negative_prompt: str = "",
        input_image: str = "",
        strength: float | None = None,
        size: str = "",
        n: int = 1,
        seed: int | None = None,
        steps: int | None = None,
        cfg_scale: float | None = None,
        backend: str = "auto",
    ) -> str:
        """Render the prompt and report where the files landed.

        Never raises into the agent loop — every failure comes back as
        ``Error: …`` so the model can adjust and retry.
        """
        emit = ImageProgressEmitter(self.progress_queue)
        try:
            return await self._run(
                emit,
                prompt=prompt,
                negative_prompt=negative_prompt,
                input_image=input_image,
                strength=strength,
                size=size,
                n=n,
                seed=seed,
                steps=steps,
                cfg_scale=cfg_scale,
                backend=backend,
            )
        except ImageGenError as exc:
            emit.failed(str(exc))
            return f"Error: {exc}"
        except Exception as exc:  # noqa: BLE001 — the tool must never raise into the loop
            emit.failed(str(exc))
            return f"Error generating image: {exc}"
        finally:
            emit.done()

    # ------------------------------------------------------------------
    # internal
    # ------------------------------------------------------------------

    async def _run(self, emit: ImageProgressEmitter, **kwargs: Any) -> str:
        text = str(kwargs.get("prompt") or "").strip()
        if not text:
            return "Error: image_generate needs a non-empty 'prompt'."

        width, height = _parse_size(str(kwargs.get("size") or ""))
        count = _clamp_int(kwargs.get("n"), 1, 1, MAX_IMAGES)
        requested = str(kwargs.get("backend") or "auto")
        if requested not in ("auto", "api", "a1111", "comfy"):
            requested = "auto"
        # The model only overrides when it names a backend; otherwise the user's
        # setting decides, and only then does "auto" walk the chain.
        if requested == "auto":
            requested = self._config.backend

        init_b64, init_mime = "", "image/png"
        source = str(kwargs.get("input_image") or "").strip()
        if source:
            init_b64, init_mime = await self._read_source(source)

        req = ImageRequest(
            prompt=text,
            negative_prompt=str(kwargs.get("negative_prompt") or "").strip(),
            width=width,
            height=height,
            steps=_optional_int(kwargs.get("steps"), 1, 150),
            cfg_scale=_optional_float(kwargs.get("cfg_scale"), 0.5, 30.0),
            seed=_optional_int(kwargs.get("seed"), 0, 2**32 - 1),
            n=count,
            init_image_b64=init_b64,
            init_image_mime=init_mime,
            strength=_clamp_float(kwargs.get("strength"), 0.6, 0.05, 0.95),
        )

        effective = self._service.resolve(self._config, requested)  # type: ignore[arg-type]
        emit.start(effective, text, count)
        result = await self._service.generate(
            req, self._config, emit, requested=requested  # type: ignore[arg-type]
        )

        paths = await self._save(result.images, text, emit)
        return _summary(paths, result, req)

    async def _read_source(self, path: str) -> tuple[str, str]:
        """Load the img2img source as base64, sandbox-checked."""
        resolved = _resolve_write_path(path, self._policy)
        if not resolved or not (resolved.startswith("/") or _looks_windows_abs(resolved)):
            raise ImageGenError(f"could not resolve input_image {path!r} to an absolute path")
        denied = self._policy.check_read(resolved)
        if denied:
            raise ImageGenError(denied)

        suffix = Path(resolved).suffix.lower()
        mime = _SOURCE_MIME.get(suffix)
        if mime is None:
            raise ImageGenError(
                f"input_image must be a .png, .jpg or .webp file — got {suffix or 'no extension'}"
            )
        try:
            if resolved.startswith("/"):
                data = await host_read_bytes(resolved)
            else:
                data = Path(resolved).read_bytes()
        except FileNotFoundError as exc:
            raise ImageGenError(f"input_image not found — {resolved}") from exc
        except OSError as exc:
            raise ImageGenError(f"could not read input_image: {exc}") from exc
        return base64.b64encode(data).decode("ascii"), mime

    async def _save(
        self, images: list[GeneratedImage], prompt: str, emit: ImageProgressEmitter
    ) -> list[str]:
        """Write each image into ``<chat folder>/images/`` and announce it."""
        stem = f"{_slugify(prompt)}-{datetime.now():%H%M%S}-{uuid.uuid4().hex[:4]}"
        paths: list[str] = []
        for index, image in enumerate(images):
            suffix = ".jpg" if image.mime == "image/jpeg" else ".png"
            name = f"{stem}{suffix}" if len(images) == 1 else f"{stem}-{index + 1}{suffix}"
            resolved = _resolve_write_path(f"images/{name}", self._policy)
            if not resolved or not (resolved.startswith("/") or _looks_windows_abs(resolved)):
                raise ImageGenError(
                    "this chat has no working folder, so there is nowhere to save the image"
                )
            denied = self._policy.check_write(resolved)
            if denied:
                raise ImageGenError(denied)

            if resolved.startswith("/"):
                await host_write_bytes(resolved, image.data)
            else:
                target = Path(resolved)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(image.data)

            paths.append(resolved)
            emit.image(
                resolved,
                index=index,
                width=image.width,
                height=image.height,
                seed=image.seed,
            )
        return paths


# ---------------------------------------------------------------------------
# argument + result helpers
# ---------------------------------------------------------------------------


def _parse_size(raw: str) -> tuple[int, int]:
    """``"1024x768"`` → ``(1024, 768)``, clamped and snapped to a multiple of 8."""
    match = _SIZE_RE.match(raw)
    if not match:
        return DEFAULT_SIZE, DEFAULT_SIZE
    return _snap(int(match.group(1))), _snap(int(match.group(2)))


def _snap(value: int) -> int:
    """Diffusion samplers work in latent blocks; odd sizes fail or get cropped."""
    clamped = max(MIN_SIZE, min(MAX_SIZE, value))
    return clamped - (clamped % 8)


def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _clamp_float(value: Any, default: float, low: float, high: float) -> float:
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return default


def _optional_int(value: Any, low: int, high: int) -> int | None:
    if value is None or value == "":
        return None
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return None


def _optional_float(value: Any, low: float, high: float) -> float | None:
    if value is None or value == "":
        return None
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return None


def _slugify(prompt: str) -> str:
    """A short, filesystem-safe stem from the prompt's first few ASCII words."""
    words = [w for w in _SLUG_KEEP.split(prompt.lower()) if w][:6]
    slug = "-".join(words)[:48].strip("-")
    # Non-Latin prompts slugify to nothing; the timestamp still makes it unique.
    return slug or "image"


def _summary(paths: list[str], result: ImageGenResult, req: ImageRequest) -> str:
    """The text the model reads back — paths first, then what to do next."""
    seeds = [i.seed for i in result.images if i.seed is not None]
    detail = f"{req.width}x{req.height} via {result.backend}"
    if seeds:
        detail += f", seed {', '.join(str(s) for s in seeds)}"
    noun = "image" if len(paths) == 1 else "images"

    lines = [f"Generated {len(paths)} {noun} ({detail}):", *paths]
    if result.warnings:
        lines += ["", *(f"Note: {w}" for w in result.warnings)]
    lines += [
        "",
        "The user can already see the result. Call read_photo on a path if you "
        "need to check how it actually turned out, present_files if the user "
        "should get a download card, and mention the seed if they might want to "
        "iterate on this exact image.",
    ]
    return "\n".join(lines)
