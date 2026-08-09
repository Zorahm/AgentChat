"""Hosted image APIs, through LiteLLM.

Reuses the providers the user already configured for chat — the model id, key
and api_base arrive on :class:`ImageGenConfig` already resolved and re-tagged
(see ``store.settings_store.build_image_config``), so this module never touches
the settings store.

Hosted models take a much narrower parameter set than a local sampler does; the
ones they cannot honour come back as warnings rather than silent no-ops.
"""

from __future__ import annotations

import base64
from typing import Any

import httpx
import litellm

from images.config import (
    GeneratedImage,
    ImageGenConfig,
    ImageGenError,
    ImageGenResult,
    ImageRequest,
)
from images.probe import mime_for, probe_size
from images.progress import ImageProgressEmitter

# Sizes each known family accepts. An unlisted model gets the requested size
# passed through — a new model should not be clamped to yesterday's list.
_SUPPORTED_SIZES: dict[str, tuple[tuple[int, int], ...]] = {
    "gpt-image-1": ((1024, 1024), (1024, 1536), (1536, 1024)),
    "dall-e-3": ((1024, 1024), (1792, 1024), (1024, 1792)),
    "dall-e-2": ((256, 256), (512, 512), (1024, 1024)),
}


async def generate(
    req: ImageRequest,
    cfg: ImageGenConfig,
    emit: ImageProgressEmitter,
) -> ImageGenResult:
    """Generate (or edit) through the configured hosted image model."""
    if not cfg.api_model:
        raise ImageGenError("No hosted image model is configured.")

    size, warnings = _resolve_size(cfg.api_model, req)
    warnings.extend(_unsupported(req))
    # Hosted APIs report nothing until they answer; one indeterminate tick keeps
    # the card from looking stalled.
    emit.progress(None, "waiting for the provider")

    kwargs: dict[str, Any] = {
        "model": cfg.api_model,
        "prompt": req.prompt,
        "n": req.n,
        "size": size,
        "timeout": cfg.timeout_s,
    }
    if cfg.api_key:
        kwargs["api_key"] = cfg.api_key
    if cfg.api_base:
        kwargs["api_base"] = cfg.api_base
    # gpt-image-1 always answers with base64 and rejects the parameter outright.
    if "gpt-image" not in cfg.api_model:
        kwargs["response_format"] = "b64_json"

    response = await _call(req, cfg, kwargs)
    images = await _decode(response, req)
    if not images:
        raise ImageGenError("The provider returned no image data.")
    return ImageGenResult(images=images, backend="api", warnings=warnings)


async def _call(req: ImageRequest, cfg: ImageGenConfig, kwargs: dict[str, Any]) -> Any:
    """Dispatch to image generation or image edit, as the request demands."""
    if req.is_edit:
        edit = getattr(litellm, "aimage_edit", None)
        if edit is None:
            raise ImageGenError(
                "Editing an image through a hosted API needs a newer LiteLLM "
                "(aimage_edit). Use a local backend for img2img, or upgrade LiteLLM."
            )
        try:
            source = base64.b64decode(req.init_image_b64)
        except (ValueError, TypeError) as exc:
            raise ImageGenError(f"The source image could not be decoded: {exc}") from exc
        # The SDK reads a name off the file object to pick the upload's mime type.
        upload = _NamedBytes(source, "source.png" if req.init_image_mime != "image/jpeg" else "source.jpg")
        kwargs.pop("response_format", None)
        try:
            return await edit(image=upload, **kwargs)
        except Exception as exc:  # noqa: BLE001 — provider errors are all shapes
            raise ImageGenError(f"The image edit failed: {exc}") from exc

    try:
        return await litellm.aimage_generation(**kwargs)
    except Exception as exc:  # noqa: BLE001 — provider errors are all shapes
        raise ImageGenError(f"The image generation failed: {exc}") from exc


async def _decode(response: Any, req: ImageRequest) -> list[GeneratedImage]:
    """Turn the provider's ``data`` entries into bytes, fetching any URLs."""
    entries = getattr(response, "data", None) or []
    images: list[GeneratedImage] = []
    for entry in entries[: req.n]:
        data = await _entry_bytes(entry)
        if data is None:
            continue
        width, height = probe_size(data)
        images.append(
            GeneratedImage(
                data=data,
                mime=mime_for(data),
                width=width or req.width,
                height=height or req.height,
                seed=None,  # no hosted API reports one
            )
        )
    return images


async def _entry_bytes(entry: Any) -> bytes | None:
    """One ``data`` entry, which carries either base64 or a short-lived URL."""
    b64 = _field(entry, "b64_json")
    if isinstance(b64, str) and b64:
        try:
            return base64.b64decode(b64)
        except (ValueError, TypeError) as exc:
            raise ImageGenError(f"The provider returned unreadable image data: {exc}") from exc
    url = _field(entry, "url")
    if isinstance(url, str) and url:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.get(url)
        except httpx.HTTPError as exc:
            raise ImageGenError(f"Could not download the generated image: {exc}") from exc
        if response.status_code >= 400:
            raise ImageGenError(f"Could not download the generated image ({response.status_code}).")
        return response.content
    return None


def _field(entry: Any, name: str) -> Any:
    """LiteLLM hands back pydantic objects for some providers and dicts for others."""
    if isinstance(entry, dict):
        return entry.get(name)
    return getattr(entry, name, None)


def _resolve_size(model: str, req: ImageRequest) -> tuple[str, list[str]]:
    """Snap the requested size onto what the model accepts, explaining any change."""
    allowed = next(
        (sizes for family, sizes in _SUPPORTED_SIZES.items() if family in model), None
    )
    if allowed is None:
        return f"{req.width}x{req.height}", []
    if (req.width, req.height) in allowed:
        return f"{req.width}x{req.height}", []

    # Closest aspect ratio wins; ties break toward the larger image.
    target = req.width / req.height if req.height else 1.0
    width, height = min(allowed, key=lambda s: (abs(s[0] / s[1] - target), -s[0] * s[1]))
    return (
        f"{width}x{height}",
        [
            f"{model} only renders {', '.join(f'{w}x{h}' for w, h in allowed)} — "
            f"used {width}x{height} instead of {req.width}x{req.height}."
        ],
    )


def _unsupported(req: ImageRequest) -> list[str]:
    """Sampler-only parameters a hosted API has no equivalent for."""
    dropped = []
    if req.negative_prompt:
        dropped.append("negative_prompt")
    if req.steps is not None:
        dropped.append("steps")
    if req.cfg_scale is not None:
        dropped.append("cfg_scale")
    if req.seed is not None:
        dropped.append("seed")
    if not dropped:
        return []
    return [
        f"The hosted model ignored {', '.join(dropped)} — describe what you want "
        "avoided in the prompt itself, or switch to a local backend."
    ]


class _NamedBytes(bytes):
    """Bytes that carry a filename, which is how the SDK types an upload."""

    name: str

    def __new__(cls, data: bytes, name: str) -> "_NamedBytes":
        obj = super().__new__(cls, data)
        obj.name = name
        return obj
