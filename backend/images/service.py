"""Route one image request to a backend and hand back the finished images.

The service owns exactly two decisions: *which* backend runs, and how a failure
is phrased. Everything about how an image is actually made lives in
``images/backends/``; everything about where the bytes end up lives in the
``image_generate`` tool.

There is deliberately **no** silent fallback between backends. If the local
sampler the user chose is down, quietly billing their OpenAI key instead is not
a kindness — the error names the alternatives and lets the model retry.
"""

from __future__ import annotations

from images.config import (
    AUTO_ORDER,
    BackendStatus,
    EffectiveImageBackend,
    ImageBackend,
    ImageGenConfig,
    ImageGenError,
    ImageGenResult,
    ImageRequest,
)
from images.progress import ImageProgressEmitter


class ImageGenService:
    """Stateless router over the image backends.

    Held as a singleton on app state for symmetry with
    :class:`web_search.service.WebSearchService`, but it caches nothing — every
    call is driven entirely by the :class:`ImageGenConfig` it is handed.
    """

    def resolve(self, cfg: ImageGenConfig, requested: ImageBackend = "auto") -> EffectiveImageBackend:
        """Pick the backend to run: the requested one, else the auto chain."""
        if requested != "auto" and self._is_available(cfg, requested):
            return requested
        for candidate in AUTO_ORDER:
            if self._is_available(cfg, candidate):
                return candidate
        return "none"

    def available_backends(self, cfg: ImageGenConfig) -> list[BackendStatus]:
        """Availability of every backend, for GET /api/config/images."""
        return [
            BackendStatus(
                id="a1111",
                available=cfg.a1111_available,
                reason=cfg.a1111_url or "no URL set",
            ),
            BackendStatus(
                id="comfy",
                available=cfg.comfy_available,
                reason=cfg.comfy_url or "no URL set",
            ),
            BackendStatus(
                id="api",
                available=cfg.api_available,
                reason=cfg.api_model or "no model set",
            ),
        ]

    async def generate(
        self,
        req: ImageRequest,
        cfg: ImageGenConfig,
        emit: ImageProgressEmitter,
        *,
        requested: ImageBackend = "auto",
    ) -> ImageGenResult:
        """Generate through the resolved backend, or raise :class:`ImageGenError`."""
        effective = self.resolve(cfg, requested)
        if effective == "none":
            raise ImageGenError(
                "No image backend is configured. Set one up in Settings → "
                "Providers → Image generation (a local Stable Diffusion WebUI or "
                "ComfyUI URL, or a hosted image model)."
            )
        if requested != "auto" and requested != effective:
            raise ImageGenError(
                f"The '{requested}' image backend is not configured. "
                f"Available: {self._names(cfg) or 'none'}."
            )

        # Imported lazily: each backend pulls in httpx/litellm, and a chat that
        # never generates an image should not pay for that at startup.
        if effective == "a1111":
            from images.backends import a1111

            return await a1111.generate(req, cfg, emit)
        if effective == "comfy":
            from images.backends import comfy

            return await comfy.generate(req, cfg, emit)
        from images.backends import api

        return await api.generate(req, cfg, emit)

    @staticmethod
    def _is_available(cfg: ImageGenConfig, backend: ImageBackend | EffectiveImageBackend) -> bool:
        if backend == "a1111":
            return cfg.a1111_available
        if backend == "comfy":
            return cfg.comfy_available
        if backend == "api":
            return cfg.api_available
        return False

    def _names(self, cfg: ImageGenConfig) -> str:
        return ", ".join(s.id for s in self.available_backends(cfg) if s.available)
