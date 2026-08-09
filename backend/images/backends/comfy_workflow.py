"""Load a ComfyUI API-format workflow and patch this request's values into it.

ComfyUI has no generic "generate" endpoint — you submit a node graph. Rather
than address nodes by id (which differs in every exported graph), we find the
sampler by class and follow its ``positive``/``negative`` links to the text
encoders. That is what lets a user's own exported workflow work unchanged, as
long as it is built from the standard nodes.
"""

from __future__ import annotations

import copy
import json
import random
from pathlib import Path
from typing import Any

from images.config import ImageGenError, ImageRequest
from paths import resolve_bundled_workflows

_SAMPLERS = ("KSampler", "KSamplerAdvanced")
_TEXT_ENCODERS = ("CLIPTextEncode",)
_LATENT_NODES = ("EmptyLatentImage", "EmptySD3LatentImage")
_CHECKPOINT_LOADERS = ("CheckpointLoaderSimple", "CheckpointLoader")

# Node graphs are JSON objects keyed by node id; every node has a class_type
# and an inputs map. Links are ``[node_id, output_index]`` pairs.
Workflow = dict[str, Any]


def load_workflow(*, is_edit: bool, custom_path: str | None = None) -> Workflow:
    """Read the workflow to submit — the user's if one is configured."""
    path = Path(custom_path.strip()) if custom_path and custom_path.strip() else None
    if path is None:
        path = resolve_bundled_workflows() / ("img2img.json" if is_edit else "txt2img.json")
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ImageGenError(f"Could not read the ComfyUI workflow at {path}: {exc}") from exc
    try:
        workflow = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ImageGenError(
            f"The ComfyUI workflow at {path} is not valid JSON — export it in "
            f"API format (Settings → Enable dev mode → Save (API format)): {exc}"
        ) from exc
    if not isinstance(workflow, dict) or not workflow:
        raise ImageGenError(f"The ComfyUI workflow at {path} is empty or not an API-format graph.")
    return workflow


def patch_workflow(
    workflow: Workflow,
    req: ImageRequest,
    *,
    checkpoint: str = "",
    image_name: str = "",
) -> tuple[Workflow, int]:
    """Return a patched copy of *workflow* plus the seed it was given.

    The seed is returned because ComfyUI never reports it back, and an image
    the user cannot reproduce is worth less than one they can.
    """
    graph: Workflow = copy.deepcopy(workflow)
    sampler_id, sampler = _find_by_class(graph, _SAMPLERS)
    if sampler is None:
        raise ImageGenError(
            "The ComfyUI workflow has no KSampler node — AgentChat cannot tell "
            "where to put the prompt. Use the bundled workflow or one built on KSampler."
        )
    inputs: dict[str, Any] = sampler.setdefault("inputs", {})

    seed = req.seed if req.seed is not None else random.randint(0, 2**31 - 1)
    # KSamplerAdvanced spells the same field differently; set whichever it has.
    inputs["noise_seed" if "noise_seed" in inputs else "seed"] = seed
    if req.steps is not None:
        inputs["steps"] = req.steps
    if req.cfg_scale is not None:
        inputs["cfg"] = req.cfg_scale
    if req.is_edit:
        inputs["denoise"] = req.strength

    _set_prompt(graph, inputs.get("positive"), req.prompt, sampler_id, "positive")
    if req.negative_prompt:
        _set_prompt(graph, inputs.get("negative"), req.negative_prompt, sampler_id, "negative")

    _patch_latent(graph, req)
    if checkpoint:
        _, loader = _find_by_class(graph, _CHECKPOINT_LOADERS)
        if loader is not None:
            loader.setdefault("inputs", {})["ckpt_name"] = checkpoint
    if req.is_edit:
        _patch_load_image(graph, image_name)

    return graph, seed


def workflow_checkpoint(workflow: Workflow) -> str:
    """The checkpoint the graph already names, if any."""
    _, loader = _find_by_class(workflow, _CHECKPOINT_LOADERS)
    if loader is None:
        return ""
    name = (loader.get("inputs") or {}).get("ckpt_name")
    return name if isinstance(name, str) else ""


# ---------------------------------------------------------------------------
# internal
# ---------------------------------------------------------------------------


def _find_by_class(graph: Workflow, classes: tuple[str, ...]) -> tuple[str, dict[str, Any] | None]:
    """First node whose ``class_type`` is in *classes*, in node-id order."""
    for node_id in sorted(graph, key=_id_sort_key):
        node = graph.get(node_id)
        if isinstance(node, dict) and node.get("class_type") in classes:
            return node_id, node
    return "", None


def _id_sort_key(node_id: str) -> tuple[int, int | str]:
    """Numeric ids sort numerically; anything else sorts after, as text."""
    return (0, int(node_id)) if node_id.isdigit() else (1, node_id)


def _set_prompt(
    graph: Workflow, link: Any, text: str, sampler_id: str, slot: str
) -> None:
    """Write *text* into the CLIPTextEncode the sampler's *slot* points at."""
    node = _follow(graph, link)
    if node is None or node.get("class_type") not in _TEXT_ENCODERS:
        raise ImageGenError(
            f"The ComfyUI workflow's sampler (node {sampler_id}) does not take its "
            f"{slot} conditioning from a CLIPTextEncode node, so AgentChat cannot "
            "place the prompt. Use the bundled workflow or a standard one."
        )
    node.setdefault("inputs", {})["text"] = text


def _follow(graph: Workflow, link: Any) -> dict[str, Any] | None:
    """Resolve a ``[node_id, output_index]`` link to its node."""
    if not isinstance(link, list) or not link:
        return None
    node = graph.get(str(link[0]))
    return node if isinstance(node, dict) else None


def _patch_latent(graph: Workflow, req: ImageRequest) -> None:
    """Size + batch live on the empty-latent node; img2img graphs have none."""
    _, latent = _find_by_class(graph, _LATENT_NODES)
    if latent is None:
        return
    inputs = latent.setdefault("inputs", {})
    inputs["width"] = req.width
    inputs["height"] = req.height
    inputs["batch_size"] = req.n


def _patch_load_image(graph: Workflow, image_name: str) -> None:
    _, loader = _find_by_class(graph, ("LoadImage",))
    if loader is None:
        raise ImageGenError(
            "The ComfyUI workflow has no LoadImage node, so there is nowhere to "
            "put the source image. Use the bundled img2img workflow."
        )
    loader.setdefault("inputs", {})["image"] = image_name
