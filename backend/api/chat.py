"""POST /api/chat — SSE streaming endpoint."""

from __future__ import annotations

import json
import re
from typing import Any

import litellm
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from agent.config import AgentConfig
from agent.loop import AgentLoop
from agent.sandbox import SandboxPolicy
from api.schemas.chat import AttachmentInfo, ChatRequest
from llm.client import LLMClient
from mcp_integration.manager import MCPManager
from mcp_integration.registry_view import MCPAwareRegistry
from mcp_integration.tool_proxy import MCPToolProxy
from tools.base import BaseTool
from tools.bash_tool import BashTool
from tools.edit_file import EditFileTool
from tools.read_file import ReadFileTool
from tools.read_photo import ReadPhotoTool
from tools.registry import ToolRegistry
from tools.write_file import WriteFileTool

INLINE_CONTENT_LIMIT = 50_000

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")


def _resolve_chat_cwd(slug: str | None, user_home: str, shell: str = "wsl") -> str:
    """Map a chat slug to an absolute path under ~/AgentChat/chats/.

    For ``shell="wsl"`` returns a WSL path with forward slashes; for
    ``shell="powershell"`` returns a Windows path with backslashes. Empty
    string is returned for missing / malformed slug — bash_tool then falls
    back to whatever cwd the shell picks. Slugs are validated against a
    strict regex to keep command injection out of the shell prefix.
    """
    if not slug or not _SLUG_RE.match(slug):
        return ""
    if shell == "powershell":
        return f"{user_home}\\AgentChat\\chats\\{slug}"
    return f"{user_home}/AgentChat/chats/{slug}"


router = APIRouter(prefix="/chat", tags=["chat"])


async def _build_mcp_proxies(
    enabled_ids: list[str] | None,
    settings_store: Any,
    manager: MCPManager,
) -> list[BaseTool]:
    """Spin up requested MCP servers and return one proxy per discovered tool.

    Unknown / disabled IDs are silently dropped. A spawn error logs and
    skips that one server — the rest still load. The agent sees zero MCP
    tools from a failed server, and the UI surfaces the error via the
    server-status endpoint.
    """
    if not enabled_ids:
        return []

    proxies: list[BaseTool] = []
    for server_id in enabled_ids:
        cfg = settings_store.get_mcp_server(server_id)
        if cfg is None or not cfg.enabled:
            continue
        try:
            tools = await manager.ensure_started(cfg)
        except Exception:  # noqa: BLE001 — manager already logged
            continue
        for tool in tools:
            proxies.append(
                MCPToolProxy(
                    manager=manager,
                    cfg=cfg,
                    tool_name=tool.name,
                    description=tool.description,
                    input_schema=tool.input_schema,
                )
            )
    return proxies


def _sse_event(event_type: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event_type}\ndata: {payload}\n\n"


def _model_supports_vision(model: str) -> bool:
    """Best-effort check via LiteLLM's capability registry.

    Unknown providers / proxy aliases raise — treat any exception as
    "unknown, assume no vision" so we degrade safely instead of crashing
    the request with an unsupported image_url block."""
    try:
        return bool(litellm.supports_vision(model=model))
    except Exception:
        return False


def _format_user_content(
    text: str,
    attachments: list[AttachmentInfo] | None,
    *,
    vision: bool,
) -> str | list[dict[str, Any]]:
    """Build the user message content with attachment info inline.

    Returns a plain string for text-only messages, or a vision-format list
    when images are attached AND the model supports vision. For non-vision
    models, images are still mentioned by path so the model can move,
    embed, or transform the file via bash / python — it just can't *see* it.

    Text attachments smaller than INLINE_CONTENT_LIMIT chars are inlined.
    Larger ones are referenced by path with a read_file hint so the model
    can read them in chunks using offset/limit.
    """
    if not attachments:
        return text

    images = [a for a in attachments if a.mime_type.startswith("image/")]
    inline_files: list[AttachmentInfo] = []
    offloaded_files: list[AttachmentInfo] = []
    binary_files: list[AttachmentInfo] = []

    for a in attachments:
        if a.mime_type.startswith("image/"):
            continue
        if a.content and len(a.content) <= INLINE_CONTENT_LIMIT:
            inline_files.append(a)
        elif a.content and a.path:
            offloaded_files.append(a)
        elif a.content:
            inline_files.append(a)
        else:
            binary_files.append(a)

    summary_parts: list[str] = []
    for a in attachments:
        kb = a.size / 1024
        sz = f"{kb:.0f}KB" if kb < 1024 else f"{kb / 1024:.1f}MB"
        summary_parts.append(f"{a.name} ({sz})")
    header = "📎 " + ", ".join(summary_parts)

    def _fmt_offloaded(a: AttachmentInfo) -> str:
        lines = a.content.count("\n") + (1 if not a.content.endswith("\n") else 0)
        kb = a.size / 1024
        size_str = f"{kb:.0f}KB" if kb < 1024 else f"{kb / 1024:.1f}MB"
        return (
            f"\nФайл «{a.name}» ({size_str}, {lines} строк) сохранён: {a.path}\n"
            "Файл длинный — не читай его целиком. Используй read_file с offset "
            "и limit для постраничного чтения (например: offset=1, limit=200)."
        )

    def _fmt_text_file(a: AttachmentInfo) -> str:
        """Formatting for text/plain files uploaded without inline content (large pastes)."""
        kb = a.size / 1024
        size_str = f"{kb:.0f}KB" if kb < 1024 else f"{kb / 1024:.1f}MB"
        return (
            f"\nТекстовый файл «{a.name}» ({size_str}) сохранён: {a.path}\n"
            "Читай его инструментом read_file с offset и limit для постраничного чтения "
            "(например: offset=1, limit=200). Не читай весь файл сразу."
        )

    use_vision = vision and any(img.data_url for img in images)

    if use_vision:
        text_parts: list[str] = [header]
        for tf in inline_files:
            text_parts.append(f"\n--- {tf.name} ---\n{tf.content}")
        for of_ in offloaded_files:
            text_parts.append(_fmt_offloaded(of_))
        for bf in binary_files:
            if bf.mime_type == "text/plain" and bf.path:
                text_parts.append(_fmt_text_file(bf))
            else:
                text_parts.append(f"\nФайл доступен по пути: {bf.path}\n(используй read_file или bash_tool для чтения)")
        for img in images:
            if img.path:
                text_parts.append(
                    f"\nИзображение «{img.name}» сохранено: {img.path}\n"
                    "(можно прочитать/обработать через bash_tool — convert, "
                    "ffmpeg, python+PIL и т.п.)"
                )
        text_parts.append(f"\n---\n{text}")

        content_blocks: list[dict[str, Any]] = [
            {"type": "text", "text": "\n".join(text_parts)}
        ]
        for img in images:
            if img.data_url:
                content_blocks.append({
                    "type": "image_url",
                    "image_url": {"url": img.data_url},
                })
        return content_blocks

    # No vision (model can't see images, or there are no images) — plain text
    # with file paths. Model can still operate on images by path.
    parts: list[str] = [header]
    for tf in inline_files:
        parts.append(f"\n--- {tf.name} ---\n{tf.content}")
    for of_ in offloaded_files:
        parts.append(_fmt_offloaded(of_))
    for bf in binary_files:
        parts.append(f"\nФайл доступен по пути: {bf.path}\n(используй read_file или bash_tool для чтения)")
    for img in images:
        if img.path:
            note = (
                "(модель без vision — содержимое картинки не видно, но файл "
                "доступен: можно перемещать, копировать, встраивать в .docx/.pdf, "
                "конвертировать через convert/ffmpeg/PIL, читать метаданные через "
                "`identify` или `exiftool`)"
                if not vision
                else "(используй bash_tool для обработки)"
            )
            parts.append(f"\nИзображение «{img.name}»: {img.path}\n{note}")
    parts.append(f"\n---\n{text}")
    return "\n".join(parts)


@router.post("")
async def chat(
    request: Request,
    body: ChatRequest,
) -> StreamingResponse:
    """Stream an agent response via SSE.

    The last message must have ``role == "user"``; all prior messages are
    loaded as conversation history.
    """
    app_state = request.app.state
    store = app_state.settings_store

    if not body.messages:
        raise HTTPException(status_code=400, detail="messages array is empty")
    if body.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail="Last message must have role='user'")

    new_message = body.messages[-1].content
    history = body.messages[:-1]

    # Resolve model and provider
    model = body.model or store.default_model
    provider = store.get_provider(model)

    if provider is None and "/" in model:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider '{model.split('/')[0]}'. Add it in Settings.",
        )

    api_key = provider.api_key if provider else None
    api_base = provider.api_base if provider else None

    # Remap opencode/ prefix to openai/ for LiteLLM compatibility
    lite_model = model
    if provider is not None and provider.id == "opencode" and "/" in model:
        lite_model = f"openai/{model.split('/', 1)[1]}"

    # Resolve thinking control
    model_cfg = store.get_model_config(model)
    extra_body: dict[str, Any] | None = None
    if model_cfg is not None and model_cfg.thinking is False:
        extra_body = {"thinking": {"type": "disabled"}}

    # Build fresh system prompt (includes current date + artifact instructions)
    system_prompt: str = app_state.system_prompt_factory()

    config = AgentConfig(
        model=lite_model,
        system_prompt=system_prompt,
        api_key=api_key,
        api_base=api_base,
        temperature=store.temperature,
        max_iterations=store.max_iterations,
        extra_body=extra_body,
    )

    base_registry: ToolRegistry = app_state.tool_registry
    mcp_proxies = await _build_mcp_proxies(
        body.mcp_enabled_servers, store, app_state.mcp_manager
    )
    registry: ToolRegistry = (
        MCPAwareRegistry(base_registry, mcp_proxies) if mcp_proxies else base_registry
    )

    # Build the per-chat sandbox policy and push it into every tool that can
    # touch the filesystem plus the agent loop (which handles <file>/<edit>
    # stream tags). In restricted mode bash_tool is wrapped with bwrap and
    # read/write tools refuse paths outside their allowed scope.
    from main import (
        USER_HOME,
        USER_NAME,
        WSL_USER_HOME,
        get_allowed_read_prefixes,
        get_blocked_read_prefixes,
        resolve_active_shell,
    )
    active_shell = resolve_active_shell(store.shell_preference)
    home = USER_HOME if active_shell == "powershell" else WSL_USER_HOME
    chat_dir = _resolve_chat_cwd(body.chat_dir_slug, home, shell=active_shell)
    policy = SandboxPolicy(
        chat_dir=chat_dir,
        blocked_read_prefixes=get_blocked_read_prefixes(),
        allowed_read_prefixes=get_allowed_read_prefixes(),
        user_name=USER_NAME,
        unrestricted=store.unrestricted_mode,
        shell=active_shell,
    )

    bash = registry.get(BashTool.name)
    if isinstance(bash, BashTool):
        bash.set_policy(policy)
    read = registry.get(ReadFileTool.name)
    if isinstance(read, ReadFileTool):
        read.set_policy(policy)
    read_photo = registry.get(ReadPhotoTool.name)
    if isinstance(read_photo, ReadPhotoTool):
        read_photo.set_policy(policy)
        read_photo.set_vision_supported(_model_supports_vision(lite_model))
    write = registry.get(WriteFileTool.name)
    if isinstance(write, WriteFileTool):
        write.set_policy(policy)
    edit = registry.get(EditFileTool.name)
    if isinstance(edit, EditFileTool):
        edit.set_policy(policy)

    llm = LLMClient(api_base=config.api_base, api_key=config.api_key)
    agent = AgentLoop(config=config, tools=registry, llm=llm, policy=policy)
    app_state.skill_reader.rebuild()
    agent.set_manifest(app_state.skill_reader.render_prompt())

    for msg in history:
        agent.messages.append({"role": msg.role, "content": msg.content})

    user_content = _format_user_content(
        new_message,
        body.attachments,
        vision=_model_supports_vision(lite_model),
    )

    async def event_stream() -> Any:
        try:
            async for event in agent.run_stream(user_content):
                yield _sse_event(event["type"], event)
        except Exception as exc:
            yield _sse_event("error", {"message": str(exc)})
        finally:
            if body.chat_id:
                try:
                    app_state.chat_store.touch_chat(body.chat_id)
                except Exception:
                    pass  # non-critical

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
