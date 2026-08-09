"""image_generate: argument handling, backend routing, and where files land."""

from __future__ import annotations

import asyncio
import base64
import json
import struct
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import images.backends.a1111 as a1111
from agent.sandbox import SandboxPolicy
from images.backends.api import _resolve_size
from images.backends.comfy_workflow import load_workflow, patch_workflow
from images.config import (
    GeneratedImage,
    ImageGenConfig,
    ImageGenError,
    ImageGenResult,
    ImageRequest,
)
from images.probe import mime_for, probe_size
from images.progress import ImageProgressEmitter
from images.service import ImageGenService
from shell import resolve_active_shell
from tools.image_generate import ImageGenerateTool, _parse_size, _slugify

# Images are written into a real ``tmp_path``, so the policy's path namespace
# has to match the host's (see tests/backend/test_tools.py).
HOST_SHELL = resolve_active_shell("powershell")


def _png(width: int = 8, height: int = 4) -> bytes:
    """A minimal but structurally valid PNG, so probe_size has real bytes."""

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    body = zlib.compress(b"\x00" + b"\x00" * (width * 3) * height)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", body) + chunk(b"IEND", b"")


# ── argument normalization ───────────────────────────────────────────────────


class TestArguments:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("1024x1024", (1024, 1024)),
            ("1344 x 768", (1344, 768)),
            ("512×512", (512, 512)),
            ("", (1024, 1024)),
            ("garbage", (1024, 1024)),
            # Clamped to the supported range, then snapped to a multiple of 8.
            ("9000x9000", (2048, 2048)),
            ("100x100", (128, 128)),
            ("1023x769", (1016, 768)),
        ],
    )
    def test_parse_size(self, raw: str, expected: tuple[int, int]) -> None:
        assert _parse_size(raw) == expected

    def test_slugify_uses_the_first_words(self) -> None:
        assert _slugify("A cat sitting on a windowsill at dusk") == "a-cat-sitting-on-a-windowsill"

    def test_slugify_falls_back_for_non_latin(self) -> None:
        # Cyrillic slugifies to nothing; the stem must still be usable.
        assert _slugify("кот на подоконнике") == "image"


class TestProbe:
    def test_reads_png_dimensions(self) -> None:
        assert probe_size(_png(64, 32)) == (64, 32)
        assert mime_for(_png()) == "image/png"

    def test_unknown_format_is_not_a_crash(self) -> None:
        assert probe_size(b"not an image at all") == (0, 0)


# ── backend routing ──────────────────────────────────────────────────────────


class TestServiceResolution:
    def test_nothing_configured(self) -> None:
        assert ImageGenService().resolve(ImageGenConfig()) == "none"

    def test_auto_prefers_local_over_paid(self) -> None:
        cfg = ImageGenConfig(a1111_url="http://local", api_model="openai/dall-e-3")
        assert ImageGenService().resolve(cfg) == "a1111"

    def test_auto_falls_through_to_the_api(self) -> None:
        assert ImageGenService().resolve(ImageGenConfig(api_model="openai/dall-e-3")) == "api"

    def test_explicit_backend_wins(self) -> None:
        cfg = ImageGenConfig(a1111_url="http://local", comfy_url="http://comfy")
        assert ImageGenService().resolve(cfg, "comfy") == "comfy"

    @pytest.mark.asyncio
    async def test_unconfigured_request_does_not_silently_bill_the_api(self) -> None:
        # Falling back from a dead local sampler to a paid API would spend the
        # user's money without asking — it must raise instead.
        cfg = ImageGenConfig(api_model="openai/dall-e-3")
        with pytest.raises(ImageGenError, match="comfy"):
            await ImageGenService().generate(
                ImageRequest(prompt="x"), cfg, ImageProgressEmitter(), requested="comfy"
            )

    @pytest.mark.asyncio
    async def test_no_backend_at_all_explains_itself(self) -> None:
        with pytest.raises(ImageGenError, match="Settings"):
            await ImageGenService().generate(
                ImageRequest(prompt="x"), ImageGenConfig(), ImageProgressEmitter()
            )


class TestHostedSizes:
    def test_supported_size_passes_through(self) -> None:
        size, warnings = _resolve_size("dall-e-3", ImageRequest(prompt="x", width=1024, height=1024))
        assert size == "1024x1024"
        assert warnings == []

    def test_unsupported_size_snaps_to_the_closest_ratio(self) -> None:
        size, warnings = _resolve_size("dall-e-3", ImageRequest(prompt="x", width=1344, height=768))
        assert size == "1792x1024"
        assert warnings and "1344x768" in warnings[0]

    def test_unknown_model_is_not_clamped(self) -> None:
        size, warnings = _resolve_size("some/new-model", ImageRequest(prompt="x", width=1344, height=768))
        assert size == "1344x768"
        assert warnings == []


# ── ComfyUI graph surgery ────────────────────────────────────────────────────


class TestComfyWorkflow:
    def test_prompts_follow_the_sampler_links(self) -> None:
        req = ImageRequest(
            prompt="a lighthouse", negative_prompt="blurry",
            width=768, height=512, n=2, seed=7, steps=30, cfg_scale=5.5,
        )
        graph, seed = patch_workflow(load_workflow(is_edit=False), req, checkpoint="sdxl.safetensors")

        sampler = graph["3"]["inputs"]
        assert (seed, sampler["seed"], sampler["steps"], sampler["cfg"]) == (7, 7, 30, 5.5)
        assert graph[str(sampler["positive"][0])]["inputs"]["text"] == "a lighthouse"
        assert graph[str(sampler["negative"][0])]["inputs"]["text"] == "blurry"
        assert graph["5"]["inputs"] == {"width": 768, "height": 512, "batch_size": 2}
        assert graph["4"]["inputs"]["ckpt_name"] == "sdxl.safetensors"

    def test_a_missing_seed_is_generated_and_reported(self) -> None:
        graph, seed = patch_workflow(load_workflow(is_edit=False), ImageRequest(prompt="x"))
        # Returned because ComfyUI never echoes it — without this the user
        # could not reproduce the image.
        assert graph["3"]["inputs"]["seed"] == seed

    def test_img2img_wires_the_source_and_strength(self) -> None:
        req = ImageRequest(
            prompt="make it night",
            init_image_b64=base64.b64encode(_png()).decode(),
            strength=0.35,
        )
        graph, _ = patch_workflow(load_workflow(is_edit=True), req, image_name="src.png")
        assert graph["3"]["inputs"]["denoise"] == 0.35
        assert graph["10"]["inputs"]["image"] == "src.png"

    def test_a_graph_without_a_sampler_is_rejected(self) -> None:
        with pytest.raises(ImageGenError, match="KSampler"):
            patch_workflow({"1": {"class_type": "SaveImage", "inputs": {}}}, ImageRequest(prompt="x"))


# ── A1111 backend ────────────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient, recording what the backend sent."""

    posts: list[tuple[str, dict[str, Any]]] = []

    def __init__(self, *_: Any, **__: Any) -> None:
        pass

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_: Any) -> bool:
        return False

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        _FakeClient.posts.append((url, kwargs.get("json") or {}))
        images = [base64.b64encode(_png(16, 8)).decode() for _ in range(3)]
        return _FakeResponse({"images": images, "info": json.dumps({"all_seeds": [11, 22]})})

    async def get(self, url: str, **_: Any) -> _FakeResponse:
        return _FakeResponse({"progress": 0.5, "state": {"sampling_step": 5, "sampling_steps": 10}})


@pytest.fixture
def fake_a1111(monkeypatch: pytest.MonkeyPatch) -> type[_FakeClient]:
    _FakeClient.posts = []
    monkeypatch.setattr(a1111.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(a1111, "_POLL_INTERVAL_S", 0.01)
    return _FakeClient


class TestA1111Backend:
    @pytest.mark.asyncio
    async def test_payload_and_grid_trimming(self, fake_a1111: type[_FakeClient]) -> None:
        req = ImageRequest(prompt="a fox", negative_prompt="text", width=768, height=512, n=2, seed=5)
        result = await a1111.generate(req, ImageGenConfig(a1111_url="http://sd/"), ImageProgressEmitter())

        url, payload = fake_a1111.posts[0]
        assert url == "http://sd/sdapi/v1/txt2img"
        assert payload["batch_size"] == 2 and payload["seed"] == 5
        assert payload["negative_prompt"] == "text"
        # save_images stays off: the chat folder is the only place a generated
        # image belongs.
        assert payload["save_images"] is False
        # Three images came back for a batch of two — the first is A1111's grid.
        assert len(result.images) == 2
        assert [i.seed for i in result.images] == [11, 22]
        assert result.images[0].width == 16

    @pytest.mark.asyncio
    async def test_a_404_names_the_missing_api_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The WebUI serves its own page without --api, so the user sees a
        # perfectly working server while every generation 404s. A bare
        # "returned 404" sends them hunting for a server that is already up.
        class _NoApiClient(_FakeClient):
            async def post(self, url: str, **_: Any) -> _FakeResponse:
                return _FakeResponse({"detail": "Not Found"}, status_code=404)

        monkeypatch.setattr(a1111.httpx, "AsyncClient", _NoApiClient)
        monkeypatch.setattr(a1111, "_POLL_INTERVAL_S", 0.01)

        with pytest.raises(ImageGenError) as excinfo:
            await a1111.generate(
                ImageRequest(prompt="x"),
                ImageGenConfig(a1111_url="http://sd"),
                ImageProgressEmitter(),
            )
        message = str(excinfo.value)
        assert "--api" in message
        assert "webui-user" in message

    @pytest.mark.asyncio
    async def test_img2img_hits_the_other_endpoint(self, fake_a1111: type[_FakeClient]) -> None:
        req = ImageRequest(
            prompt="night", n=1, strength=0.4,
            init_image_b64=base64.b64encode(_png()).decode(),
        )
        await a1111.generate(req, ImageGenConfig(a1111_url="http://sd"), ImageProgressEmitter())
        url, payload = fake_a1111.posts[0]
        assert url.endswith("/sdapi/v1/img2img")
        assert payload["denoising_strength"] == 0.4 and payload["init_images"]


# ── the tool itself ──────────────────────────────────────────────────────────


class _StubService:
    """An ImageGenService that renders instantly, so the tool can be tested alone."""

    def __init__(self, count: int = 1, warnings: list[str] | None = None) -> None:
        self.count = count
        self.warnings = warnings or []
        self.requests: list[ImageRequest] = []

    def resolve(self, cfg: ImageGenConfig, requested: str = "auto") -> str:
        return "a1111"

    async def generate(
        self, req: ImageRequest, cfg: ImageGenConfig, emit: ImageProgressEmitter, *, requested: str = "auto"
    ) -> ImageGenResult:
        self.requests.append(req)
        images = [
            GeneratedImage(data=_png(32, 16), width=32, height=16, seed=100 + i)
            for i in range(self.count)
        ]
        return ImageGenResult(images=images, backend="a1111", warnings=self.warnings)


class _TwoCallLLM:
    """Emits a batch of tool calls in one turn, then a plain text turn."""

    def __init__(self, calls: list[tuple[str, str, str]]) -> None:
        self._calls = calls
        self.call_count = 0

    async def completion_stream(self, **_: Any) -> Any:
        self.call_count += 1
        if self.call_count > 1:
            yield _delta(SimpleNamespace(content="done", tool_calls=None))
            return
        for index, (call_id, name, arguments) in enumerate(self._calls):
            tool_call = SimpleNamespace(
                index=index,
                id=call_id,
                function=SimpleNamespace(name=name, arguments=arguments),
            )
            yield _delta(SimpleNamespace(content=None, tool_calls=[tool_call]))


def _delta(delta: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _tool(chat_dir: Path, service: _StubService) -> ImageGenerateTool:
    tool = ImageGenerateTool(service, ImageGenConfig(a1111_url="http://sd"))  # type: ignore[arg-type]
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell=HOST_SHELL))
    return tool


def _drain(tool: ImageGenerateTool) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while not tool.progress_queue.empty():
        events.append(tool.progress_queue.get_nowait())
    return events


class TestImageGenerateTool:
    @pytest.mark.asyncio
    async def test_writes_into_the_chat_images_folder(self, tmp_path: Path) -> None:
        service = _StubService()
        out = await _tool(tmp_path, service).execute(prompt="A red bicycle in the rain", size="768x512")

        written = list((tmp_path / "images").glob("*.png"))
        assert len(written) == 1
        assert written[0].name.startswith("a-red-bicycle-in-the")
        assert str(written[0]) in out
        assert "seed 100" in out
        assert service.requests[0].width == 768 and service.requests[0].height == 512

    @pytest.mark.asyncio
    async def test_streams_progress_and_the_finished_paths(self, tmp_path: Path) -> None:
        tool = _tool(tmp_path, _StubService(count=2))
        await tool.execute(prompt="two moons", n=2)

        events = _drain(tool)
        kinds = [e["kind"] for e in events]
        assert kinds[0] == "start" and kinds[-1] == "done"
        # The card is drawn from these: the paths exist nowhere else, since they
        # are only known after the tool has run.
        images = [e for e in events if e["kind"] == "image"]
        assert len(images) == 2
        assert all(Path(e["path"]).is_file() for e in images)

    @pytest.mark.asyncio
    async def test_empty_prompt_is_rejected(self, tmp_path: Path) -> None:
        out = await _tool(tmp_path, _StubService()).execute(prompt="   ")
        assert out.startswith("Error:")

    @pytest.mark.asyncio
    async def test_n_is_clamped(self, tmp_path: Path) -> None:
        service = _StubService()
        await _tool(tmp_path, service).execute(prompt="x", n=99)
        assert service.requests[0].n == 4

    @pytest.mark.asyncio
    async def test_backend_warnings_reach_the_model(self, tmp_path: Path) -> None:
        service = _StubService(warnings=["The hosted model ignored negative_prompt"])
        out = await _tool(tmp_path, service).execute(prompt="x", negative_prompt="blurry")
        assert "Note: The hosted model ignored negative_prompt" in out

    @pytest.mark.asyncio
    async def test_input_image_outside_the_sandbox_is_refused(self, tmp_path: Path) -> None:
        outside = tmp_path.parent / "secret.png"
        outside.write_bytes(_png())
        tool = ImageGenerateTool(_StubService(), ImageGenConfig(a1111_url="http://sd"))  # type: ignore[arg-type]
        tool.set_policy(
            SandboxPolicy(chat_dir=str(tmp_path / "chat"), shell=HOST_SHELL, allowed_read_prefixes=[])
        )
        out = await tool.execute(prompt="edit it", input_image=str(outside))
        assert out.startswith("Error:")

    @pytest.mark.asyncio
    async def test_input_image_is_read_and_passed_along(self, tmp_path: Path) -> None:
        source = tmp_path / "source.png"
        source.write_bytes(_png(24, 24))
        service = _StubService()
        out = await _tool(tmp_path, service).execute(
            prompt="make it snow", input_image="source.png", strength=0.3
        )
        assert not out.startswith("Error:")
        req = service.requests[0]
        assert req.is_edit and req.strength == 0.3
        assert base64.b64decode(req.init_image_b64) == source.read_bytes()

    @pytest.mark.asyncio
    async def test_a_backend_failure_becomes_a_readable_error(self, tmp_path: Path) -> None:
        class _Failing(_StubService):
            async def generate(self, *_: Any, **__: Any) -> ImageGenResult:
                raise ImageGenError("ComfyUI is unreachable at http://x")

        tool = _tool(tmp_path, _Failing())
        out = await tool.execute(prompt="x")
        assert out == "Error: ComfyUI is unreachable at http://x"
        assert [e["kind"] for e in _drain(tool)][-2:] == ["failed", "done"]

    @pytest.mark.asyncio
    async def test_several_generations_in_one_turn(self, tmp_path: Path) -> None:
        """Two image_generate calls in a single assistant turn, through the real loop.

        The tool instance — and therefore its progress queue — is shared by both
        calls, so this is where cross-wired cards would show up: an `image`
        event attributed to the wrong call would put one render's picture on the
        other's card. The loop runs a batch strictly in order and drains the
        queue between calls, which is what keeps them apart.
        """
        from agent.config import AgentConfig
        from agent.loop import AgentLoop
        from tools.registry import ToolRegistry

        service = _StubService()
        tool = _tool(tmp_path, service)
        registry = ToolRegistry()
        registry.register(tool)

        llm = _TwoCallLLM(
            [
                ("call-a", "image_generate", '{"prompt": "a red fox"}'),
                ("call-b", "image_generate", '{"prompt": "a blue whale"}'),
            ]
        )
        loop = AgentLoop(
            config=AgentConfig(model="test", max_iterations=5),
            tools=registry,
            llm=llm,  # type: ignore[arg-type]
        )

        events = [ev async for ev in loop.run_stream("draw both")]

        ends = [e for e in events if e.get("type") == "tool_end"]
        assert [e["id"] for e in ends] == ["call-a", "call-b"]
        assert all(e["success"] for e in ends)

        # Every image event must carry the id of the call that produced it.
        images: dict[str, list[str]] = {}
        for event in events:
            if event.get("type") != "tool_progress":
                continue
            payload = event["event"]
            if payload["kind"] == "image":
                images.setdefault(event["id"], []).append(payload["path"])
        assert sorted(images) == ["call-a", "call-b"]
        assert len(images["call-a"]) == 1 and len(images["call-b"]) == 1
        assert images["call-a"] != images["call-b"]

        # Both prompts really reached the backend, in order.
        assert [r.prompt for r in service.requests] == ["a red fox", "a blue whale"]
        assert len(list((tmp_path / "images").glob("*.png"))) == 2

    @pytest.mark.asyncio
    async def test_concurrent_calls_keep_their_own_queues(self, tmp_path: Path) -> None:
        # Two chats can stream at once; a shared queue would cross their cards.
        a, b = _tool(tmp_path / "a", _StubService()), _tool(tmp_path / "b", _StubService())
        await asyncio.gather(a.execute(prompt="one"), b.execute(prompt="two"))
        assert [e["kind"] for e in _drain(a)].count("image") == 1
        assert [e["kind"] for e in _drain(b)].count("image") == 1
