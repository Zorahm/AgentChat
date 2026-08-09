"""ComfyUI backend — submit a node graph, poll the queue, fetch the outputs.

ComfyUI's HTTP API is asynchronous: ``POST /prompt`` only queues the graph and
returns a ``prompt_id``; the images appear later under ``GET /history/<id>``.
Progress is deliberately coarse (queue position, not sampler steps) — the
per-step signal only exists on ComfyUI's websocket, and a websocket dependency
is not worth a smoother progress bar.

Graph surgery lives in :mod:`images.backends.comfy_workflow`.
"""

from __future__ import annotations

import asyncio
import base64
import uuid
from typing import Any

import httpx

from images.backends.comfy_workflow import (
    load_workflow,
    patch_workflow,
    workflow_checkpoint,
)
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

_POLL_INTERVAL_S = 1.0


async def generate(
    req: ImageRequest,
    cfg: ImageGenConfig,
    emit: ImageProgressEmitter,
) -> ImageGenResult:
    """Queue one graph on ComfyUI and return the images it produced."""
    base = normalize_url(cfg.comfy_url)
    if not base:
        raise ImageGenError("ComfyUI URL is not configured.")

    warnings: list[str] = []
    workflow = load_workflow(is_edit=req.is_edit, custom_path=cfg.comfy_workflow_path)
    if req.is_edit and req.n > 1:
        warnings.append("ComfyUI img2img produced a single image — n applies to text-to-image only.")

    timeout = httpx.Timeout(cfg.timeout_s, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        checkpoint = cfg.comfy_checkpoint.strip() or workflow_checkpoint(workflow)
        if not checkpoint:
            checkpoint = await _first_checkpoint(client, base)
            if not checkpoint:
                raise ImageGenError(
                    "ComfyUI has no checkpoint to load. Pick one in Settings → "
                    "Providers → Image generation, or install a model in ComfyUI."
                )

        image_name = ""
        if req.is_edit:
            image_name = await _upload_source(client, base, req)

        graph, seed = patch_workflow(
            workflow, req, checkpoint=checkpoint, image_name=image_name
        )
        prompt_id = await _queue(client, base, graph)
        history = await _await_history(client, base, prompt_id, emit)
        images = await _collect(client, base, history, req, seed)

    if not images:
        raise ImageGenError("ComfyUI finished but produced no image — check the workflow's SaveImage node.")
    return ImageGenResult(images=images, backend="comfy", warnings=warnings)


# ---------------------------------------------------------------------------
# HTTP steps
# ---------------------------------------------------------------------------


async def _queue(client: httpx.AsyncClient, base: str, graph: dict[str, Any]) -> str:
    payload = {"prompt": graph, "client_id": f"agentchat-{uuid.uuid4().hex[:12]}"}
    try:
        response = await client.post(f"{base}/prompt", json=payload)
    except httpx.HTTPError as exc:
        raise ImageGenError(f"ComfyUI is unreachable at {base}: {exc}") from exc
    if response.status_code >= 400:
        raise ImageGenError(f"ComfyUI rejected the workflow ({response.status_code}): {_detail(response)}")
    prompt_id = (response.json() or {}).get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise ImageGenError("ComfyUI accepted the workflow but returned no prompt_id.")
    return prompt_id


async def _await_history(
    client: httpx.AsyncClient,
    base: str,
    prompt_id: str,
    emit: ImageProgressEmitter,
) -> dict[str, Any]:
    """Poll until the run leaves the queue, then return its history entry."""
    while True:
        await asyncio.sleep(_POLL_INTERVAL_S)
        try:
            response = await client.get(f"{base}/history/{prompt_id}", timeout=15.0)
            entry = (response.json() or {}).get(prompt_id)
        except (httpx.HTTPError, ValueError):
            continue  # a dropped poll is not a failed run
        if isinstance(entry, dict) and entry.get("outputs"):
            _raise_if_failed(entry)
            return entry
        emit.progress(None, await _queue_status(client, base, prompt_id))


async def _queue_status(client: httpx.AsyncClient, base: str, prompt_id: str) -> str:
    """"running" / "queued (2 ahead)" — whatever the queue endpoint can tell us."""
    try:
        data = (await client.get(f"{base}/queue", timeout=10.0)).json() or {}
    except (httpx.HTTPError, ValueError):
        return ""
    running = data.get("queue_running") or []
    if any(_entry_id(item) == prompt_id for item in running):
        return "running"
    pending = data.get("queue_pending") or []
    for position, item in enumerate(pending):
        if _entry_id(item) == prompt_id:
            return f"queued ({position + 1} ahead)"
    return ""


def _entry_id(item: Any) -> str:
    """Queue rows are positional arrays: ``[number, prompt_id, graph, …]``."""
    return str(item[1]) if isinstance(item, list) and len(item) > 1 else ""


async def _upload_source(client: httpx.AsyncClient, base: str, req: ImageRequest) -> str:
    """Push the img2img source into ComfyUI's input folder, return its name."""
    suffix = "jpg" if req.init_image_mime == "image/jpeg" else "png"
    name = f"agentchat-src-{uuid.uuid4().hex[:12]}.{suffix}"
    try:
        data = base64.b64decode(req.init_image_b64)
    except (ValueError, TypeError) as exc:
        raise ImageGenError(f"The source image could not be decoded: {exc}") from exc
    try:
        response = await client.post(
            f"{base}/upload/image",
            files={"image": (name, data, req.init_image_mime)},
            data={"overwrite": "true", "type": "input"},
        )
    except httpx.HTTPError as exc:
        raise ImageGenError(f"Could not upload the source image to ComfyUI: {exc}") from exc
    if response.status_code >= 400:
        raise ImageGenError(f"ComfyUI refused the source image ({response.status_code}): {_detail(response)}")
    uploaded = (response.json() or {}).get("name")
    return uploaded if isinstance(uploaded, str) and uploaded else name


async def _collect(
    client: httpx.AsyncClient,
    base: str,
    history: dict[str, Any],
    req: ImageRequest,
    seed: int,
) -> list[GeneratedImage]:
    """Download every image the graph's output nodes saved."""
    images: list[GeneratedImage] = []
    outputs = history.get("outputs")
    if not isinstance(outputs, dict):
        return images
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for ref in node_output.get("images") or []:
            if not isinstance(ref, dict) or ref.get("type") == "temp":
                continue
            data = await _fetch_view(client, base, ref)
            if data is None:
                continue
            width, height = probe_size(data)
            images.append(
                GeneratedImage(
                    data=data,
                    mime=mime_for(data),
                    width=width or req.width,
                    height=height or req.height,
                    # ComfyUI never echoes the seed; report the one we submitted.
                    seed=seed,
                )
            )
            if len(images) >= req.n:
                return images
    return images


async def _fetch_view(
    client: httpx.AsyncClient, base: str, ref: dict[str, Any]
) -> bytes | None:
    params = {
        "filename": str(ref.get("filename", "")),
        "subfolder": str(ref.get("subfolder", "")),
        "type": str(ref.get("type", "output")),
    }
    try:
        response = await client.get(f"{base}/view", params=params, timeout=60.0)
    except httpx.HTTPError:
        return None
    return response.content if response.status_code < 400 else None


async def _first_checkpoint(client: httpx.AsyncClient, base: str) -> str:
    """Ask ComfyUI what checkpoints it has and take the first."""
    try:
        data = (await client.get(f"{base}/object_info/CheckpointLoaderSimple", timeout=15.0)).json()
    except (httpx.HTTPError, ValueError):
        return ""
    try:
        options = data["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
    except (KeyError, IndexError, TypeError):
        return ""
    return str(options[0]) if isinstance(options, list) and options else ""


def _raise_if_failed(entry: dict[str, Any]) -> None:
    """Turn ComfyUI's execution-error status into a message worth reading."""
    status = entry.get("status")
    if not isinstance(status, dict) or status.get("status_str") != "error":
        return
    for kind, payload in status.get("messages") or []:
        if kind == "execution_error" and isinstance(payload, dict):
            node = payload.get("node_type", "?")
            message = payload.get("exception_message", "unknown error")
            raise ImageGenError(f"ComfyUI failed in node {node}: {message}")
    raise ImageGenError("ComfyUI reported an execution error.")


def _detail(response: httpx.Response) -> str:
    """A short, quotable slice of an error body."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict):
        for key in ("error", "detail", "message", "node_errors"):
            value = body.get(key)
            if value:
                return str(value)[:300]
    return str(body)[:300]
