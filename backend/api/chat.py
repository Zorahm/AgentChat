"""POST /api/chat — SSE streaming endpoint."""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from agent.config import AgentConfig
from agent.loop import AgentLoop
from agent.sandbox import SandboxPolicy
from api.schemas.chat import AttachmentInfo, ChatRequest
from llm.client import LLMClient
from tools.bash_tool import BashTool
from tools.read_file import ReadFileTool
from tools.registry import ToolRegistry
from tools.write_file import WriteFileTool

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


def _sse_event(event_type: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event_type}\ndata: {payload}\n\n"


def _format_user_content(text: str, attachments: list[AttachmentInfo] | None) -> str | list[dict[str, Any]]:
    """Build the user message content with attachment info inline.

    Returns a plain string for text-only messages, or a vision-format list
    when images are attached.
    """
    if not attachments:
        return text

    images = [a for a in attachments if a.mime_type.startswith("image/")]
    text_files = [a for a in attachments if a.content and not a.mime_type.startswith("image/")]
    binary_files = [a for a in attachments if not a.content and not a.mime_type.startswith("image/")]

    # Build file summary line
    summary_parts: list[str] = []
    for a in attachments:
        kb = a.size / 1024
        sz = f"{kb:.0f}KB" if kb < 1024 else f"{kb / 1024:.1f}MB"
        summary_parts.append(f"{a.name} ({sz})")
    header = "📎 " + ", ".join(summary_parts)

    if images:
        # Vision format — content as array
        text_parts: list[str] = [header]
        for tf in text_files:
            text_parts.append(f"\n--- {tf.name} ---\n{tf.content}")
        for bf in binary_files:
            text_parts.append(f"\nФайл доступен по пути: {bf.path}\n(используй read_file или bash_tool для чтения)")
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

    # Plain text with file contents inline
    parts: list[str] = [header]
    for tf in text_files:
        parts.append(f"\n--- {tf.name} ---\n{tf.content}")
    for bf in binary_files:
        parts.append(f"\nФайл доступен по пути: {bf.path}\n(используй read_file или bash_tool для чтения)")
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

    registry: ToolRegistry = app_state.tool_registry

    # Build the per-chat sandbox policy and push it into every tool that can
    # touch the filesystem plus the agent loop (which handles <file>/<edit>
    # stream tags). In restricted mode bash_tool is wrapped with bwrap and
    # read/write tools refuse paths outside their allowed scope.
    from main import (
        USER_HOME,
        USER_NAME,
        WSL_USER_HOME,
        get_blocked_read_prefixes,
        resolve_active_shell,
    )
    active_shell = resolve_active_shell(store.shell_preference)
    home = USER_HOME if active_shell == "powershell" else WSL_USER_HOME
    chat_dir = _resolve_chat_cwd(body.chat_dir_slug, home, shell=active_shell)
    policy = SandboxPolicy(
        chat_dir=chat_dir,
        blocked_read_prefixes=get_blocked_read_prefixes(),
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
    write = registry.get(WriteFileTool.name)
    if isinstance(write, WriteFileTool):
        write.set_policy(policy)

    llm = LLMClient(api_base=config.api_base, api_key=config.api_key)
    agent = AgentLoop(config=config, tools=registry, llm=llm, policy=policy)
    app_state.skill_reader.rebuild()
    agent.set_manifest(app_state.skill_reader.render_prompt())

    for msg in history:
        agent.messages.append({"role": msg.role, "content": msg.content})

    user_content = _format_user_content(new_message, body.attachments)

    async def event_stream() -> Any:
        try:
            async for event in agent.run_stream(user_content):
                yield _sse_event(event["type"], event)
        except Exception as exc:
            yield _sse_event("error", {"message": str(exc)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
