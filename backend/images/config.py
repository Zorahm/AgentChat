"""Contracts and configuration for image generation.

A leaf module, mirroring :mod:`web_search.config`: the service, every backend
and the ``image_generate`` tool import *down* into it, so none of them needs to
know about ``store`` or ``api``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

# Requested backend. "auto" resolves at call time; the others force one.
ImageBackend = Literal["auto", "api", "a1111", "comfy"]

# The backend actually used for a call. "none" means nothing was configured.
EffectiveImageBackend = Literal["api", "a1111", "comfy", "none"]

DEFAULT_SIZE = 1024
MIN_SIZE = 128
MAX_SIZE = 2048
MAX_IMAGES = 4

# Order "auto" walks. Local first on purpose: it costs nothing per image, and a
# configured local URL is a deliberate act — the user who set it up wants it used.
AUTO_ORDER: tuple[EffectiveImageBackend, ...] = ("a1111", "comfy", "api")


class ImageRequest(BaseModel):
    """One generation request, already normalized by the tool.

    Crosses tool → service → backend, so it is the one place the parameter set
    is defined. A backend that cannot honour a field ignores it and says so via
    :class:`ImageGenResult.warnings`.
    """

    prompt: str
    negative_prompt: str = ""
    width: int = DEFAULT_SIZE
    height: int = DEFAULT_SIZE
    steps: int | None = None
    cfg_scale: float | None = None
    seed: int | None = None
    n: int = 1
    # Base64 (no data: prefix) of the source image for img2img / edit.
    init_image_b64: str = ""
    # Source image mime, needed by the API backend's multipart upload.
    init_image_mime: str = "image/png"
    # How far img2img may drift from the source, 0..1. Ignored without a source.
    strength: float = 0.6

    @property
    def is_edit(self) -> bool:
        return bool(self.init_image_b64)


@dataclass(slots=True)
class GeneratedImage:
    """One finished image.

    A dataclass rather than a model because it carries raw bytes and never
    crosses an HTTP boundary — the tool writes it to disk and returns a path.
    """

    data: bytes
    mime: str = "image/png"
    width: int = 0
    height: int = 0
    seed: int | None = None


@dataclass(slots=True)
class ImageGenResult:
    """What one :meth:`ImageGenService.generate` call produced."""

    images: list[GeneratedImage]
    backend: EffectiveImageBackend
    # Parameters the chosen backend silently dropped, phrased for the model.
    warnings: list[str]


class ImageGenConfig(BaseModel):
    """Per-request image config, assembled from settings + the active provider.

    Rebuilt on every call (like :class:`web_search.config.WebSearchConfig`) so a
    URL edited in Settings takes effect without a restart.
    """

    backend: ImageBackend = "auto"
    # "<provider>/<model>" for the API backend, e.g. "openai/gpt-image-1".
    api_model: str = ""
    api_key: str | None = None
    api_base: str | None = None
    a1111_url: str | None = None
    comfy_url: str | None = None
    # Checkpoint filename as ComfyUI knows it, e.g. "sd_xl_base_1.0.safetensors".
    # Empty leaves whatever the workflow shipped with.
    comfy_checkpoint: str = ""
    # Path to a user-exported workflow (ComfyUI "API format") replacing the
    # bundled one. Custom node graphs are the reason this exists.
    comfy_workflow_path: str | None = None
    timeout_s: float = 600.0

    @property
    def api_available(self) -> bool:
        return bool(self.api_model)

    @property
    def a1111_available(self) -> bool:
        return bool(self.a1111_url)

    @property
    def comfy_available(self) -> bool:
        return bool(self.comfy_url)

    @property
    def any_available(self) -> bool:
        return self.api_available or self.a1111_available or self.comfy_available


class BackendStatus(BaseModel):
    """Availability of one backend, surfaced by GET /api/config/images."""

    id: ImageBackend
    available: bool
    # Short human reason, e.g. "no URL set" or "openai/gpt-image-1".
    reason: str


class ImageGenError(RuntimeError):
    """A backend failed in a way the model should be told about verbatim."""


def normalize_url(url: str | None) -> str:
    """Trim a user-typed base URL to ``scheme://host:port`` form (no trailing /)."""
    return (url or "").strip().rstrip("/")
