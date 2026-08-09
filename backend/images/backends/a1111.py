"""AUTOMATIC1111-compatible backend — also serves Forge and SD.Next.

One HTTP shape covers all three: ``POST /sdapi/v1/txt2img`` (or ``/img2img``)
with a flat JSON payload, base64 PNGs back. Sampling progress comes from a
second endpoint polled while the generation request is in flight, which is why
the request is run as a task instead of a bare ``await``.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import httpx

from images.config import (
    GeneratedImage,
    ImageGenConfig,
    ImageGenError,
    ImageGenResult,
    ImageRequest,
    normalize_url,
)
from images.probe import mime_for, probe_size
from images.progress import ImageProgressEmitter

_DEFAULT_STEPS = 25
_DEFAULT_CFG = 7.0
_POLL_INTERVAL_S = 0.7


async def generate(
    req: ImageRequest,
    cfg: ImageGenConfig,
    emit: ImageProgressEmitter,
) -> ImageGenResult:
    """Run one txt2img / img2img request against an A1111-compatible server."""
    base = normalize_url(cfg.a1111_url)
    if not base:
        raise ImageGenError("Stable Diffusion WebUI URL is not configured.")

    endpoint = "img2img" if req.is_edit else "txt2img"
    payload = _build_payload(req)

    timeout = httpx.Timeout(cfg.timeout_s, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        task = asyncio.create_task(client.post(f"{base}/sdapi/v1/{endpoint}", json=payload))
        poller = asyncio.create_task(_poll_progress(client, base, task, emit))
        try:
            response = await task
        except httpx.HTTPError as exc:
            raise ImageGenError(f"Stable Diffusion WebUI is unreachable at {base}: {exc}") from exc
        finally:
            poller.cancel()
            # The poller only ever awaits sleeps and GETs; swallowing its
            # cancellation here keeps a transport hiccup from masking the real error.
            try:
                await poller
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    if response.status_code == 404:
        # By far the most common first-run failure: the WebUI is up (its page
        # loads fine) but /sdapi/v1 only exists when it was started with --api,
        # so the user sees a working server and an agent that says it is down.
        raise ImageGenError(
            f"{base} is running, but its API is switched off — /sdapi/v1/{endpoint} "
            "returned 404. Stable Diffusion WebUI and Forge only expose the API when "
            "launched with the --api flag: add it to COMMANDLINE_ARGS in "
            "webui-user.bat (Windows) or webui-user.sh (Linux) and restart the WebUI. "
            "If the flag is already set, check that the URL in Settings points at the "
            "WebUI itself and not some other service on that port."
        )
    if response.status_code >= 400:
        raise ImageGenError(f"Stable Diffusion WebUI returned {response.status_code}: {_detail(response)}")

    body = response.json()
    raw_images = body.get("images") or []
    if not raw_images:
        raise ImageGenError("Stable Diffusion WebUI returned no images.")

    seeds = _seeds_from_info(body.get("info"))
    images = _decode(raw_images, req, seeds)
    return ImageGenResult(images=images, backend="a1111", warnings=[])


def _build_payload(req: ImageRequest) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt,
        "width": req.width,
        "height": req.height,
        "steps": req.steps or _DEFAULT_STEPS,
        "cfg_scale": req.cfg_scale if req.cfg_scale is not None else _DEFAULT_CFG,
        "seed": req.seed if req.seed is not None else -1,
        "batch_size": req.n,
        "n_iter": 1,
        "send_images": True,
        # The chat folder is the only place a generated image belongs; letting
        # the WebUI also drop copies into its own outputs/ dir just litters.
        "save_images": False,
    }
    if req.is_edit:
        payload["init_images"] = [req.init_image_b64]
        payload["denoising_strength"] = req.strength
    return payload


def _decode(
    raw_images: list[str], req: ImageRequest, seeds: list[int]
) -> list[GeneratedImage]:
    """Base64 → bytes, dropping the batch grid A1111 prepends for batches."""
    if req.n > 1 and len(raw_images) == req.n + 1:
        raw_images = raw_images[1:]

    images: list[GeneratedImage] = []
    for i, raw in enumerate(raw_images[: req.n]):
        try:
            data = base64.b64decode(raw)
        except (ValueError, TypeError) as exc:
            raise ImageGenError(f"Stable Diffusion WebUI returned unreadable image data: {exc}") from exc
        width, height = probe_size(data)
        images.append(
            GeneratedImage(
                data=data,
                mime=mime_for(data),
                width=width or req.width,
                height=height or req.height,
                seed=seeds[i] if i < len(seeds) else req.seed,
            )
        )
    return images


def _seeds_from_info(info: Any) -> list[int]:
    """Pull the per-image seeds out of the JSON-in-a-string ``info`` field."""
    if not isinstance(info, str) or not info.strip():
        return []
    try:
        parsed = json.loads(info)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, dict):
        return []
    all_seeds = parsed.get("all_seeds")
    if isinstance(all_seeds, list):
        return [int(s) for s in all_seeds if isinstance(s, (int, float))]
    seed = parsed.get("seed")
    return [int(seed)] if isinstance(seed, (int, float)) else []


async def _poll_progress(
    client: httpx.AsyncClient,
    base: str,
    task: "asyncio.Task[httpx.Response]",
    emit: ImageProgressEmitter,
) -> None:
    """Report sampling progress until the generation request comes back."""
    while not task.done():
        await asyncio.sleep(_POLL_INTERVAL_S)
        if task.done():
            return
        try:
            r = await client.get(
                f"{base}/sdapi/v1/progress",
                params={"skip_current_image": "true"},
                timeout=5.0,
            )
            data = r.json()
        except (httpx.HTTPError, ValueError):
            continue  # a missed sample is not worth failing the generation over
        fraction = data.get("progress")
        if not isinstance(fraction, (int, float)):
            continue
        state = data.get("state") or {}
        step = state.get("sampling_step") if isinstance(state, dict) else None
        total = state.get("sampling_steps") if isinstance(state, dict) else None
        status = f"{step}/{total}" if isinstance(step, int) and isinstance(total, int) else ""
        emit.progress(float(fraction) * 100.0, status)


def _detail(response: httpx.Response) -> str:
    """A short, quotable slice of an error body."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict):
        for key in ("detail", "error", "message"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value[:300]
    return str(body)[:300]
