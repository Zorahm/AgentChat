"""POST /api/chat — SSE streaming endpoint."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from agent.config import AgentConfig
from agent.loop import AgentLoop
from agent.sandbox import SandboxPolicy
from agent.wsl_exec import wsl_write_bytes
from api.schemas.chat import AttachmentInfo, ChatMessage, ChatRequest
from llm.client import LLMClient
from llm.model_tag import retag_model_for_litellm
from mcp_integration.manager import MCPManager
from mcp_integration.registry_view import MCPAwareRegistry
from mcp_integration.tool_proxy import MCPToolProxy
from shell import resolve_active_shell
from tools.base import BaseTool
from tools.bash_tool import BashTool
from tools.edit_file import EditFileTool
from tools.read_file import ReadFileTool
from tools.present_files import PresentFilesTool
from tools.read_photo import ReadPhotoTool
from tools.registry import ToolRegistry
from tools.research_tool import ResearchTool
from tools.web_search_tool import WebSearchTool
from tools.write_file import WriteFileTool

INLINE_CONTENT_LIMIT = 50_000

# Appended to the system prompt when the research toggle is on, so the agent
# knows the `research` tool exists and to surface its report.md afterwards.
_RESEARCH_NUDGE = (
    "## Research tool\n\n"
    "The `research` tool is available this turn. For questions that need thorough, "
    "source-backed investigation across multiple web sources (current events, "
    "comparisons, market/literature scans), call `research(topic=...)` (optional "
    "depth 1-3, language). ALWAYS pass `language` = the user's language so the report "
    "is written in it. It runs a multi-step search → read → synthesize loop and saves a "
    "cited report. When it returns, call present_files with the EXACT absolute report "
    "path it gives you back (not a relative name) to show the report, then give the "
    "user a brief summary. Don't use it for simple lookups a single web_search would answer."
)

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


def build_agent_messages(history: list[ChatMessage]) -> list[dict[str, Any]]:
    """Reconstruct prior turns as LiteLLM-format messages.

    Plain user/assistant turns map to ``{"role", "content"}``. Assistant turns
    that carried tool calls are rebuilt as an assistant message with a
    ``tool_calls`` array, and each ``tool`` message is rebuilt with its
    ``tool_call_id`` — so the model sees the calls it made and their results,
    not just its closing text. Without this, every fact the model learned via a
    tool (file contents, command output) is dropped between turns and it behaves
    as if the work never happened.
    """
    out: list[dict[str, Any]] = []
    for msg in history:
        if msg.role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": msg.tool_call_id or "",
                    "content": msg.content,
                }
            )
        elif msg.tool_calls:
            out.append(
                {
                    "role": "assistant",
                    "content": msg.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                            },
                        }
                        for tc in msg.tool_calls
                    ],
                }
            )
        else:
            out.append({"role": msg.role, "content": msg.content})
    return out


def _sse_event(event_type: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event_type}\ndata: {payload}\n\n"


def _format_user_content(
    text: str,
    attachments: list[AttachmentInfo] | None,
) -> str | list[dict[str, Any]]:
    """Build the user message content with attachment info inline.

    Images are always attached as vision blocks (optimistically — we don't try
    to guess whether the model can see). If the model can't, the provider
    rejects the request and the agent loop swaps the pixels for the provider's
    error and retries in text. See agent.loop._is_vision_rejection.

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
            f"\nFile \"{a.name}\" ({size_str}, {lines} lines) saved: {a.path}\n"
            "File is long — do not read it in one go. Use read_file with offset "
            "and limit for paginated reading (e.g. offset=1, limit=200)."
        )

    def _fmt_text_file(a: AttachmentInfo) -> str:
        """Formatting for text/plain files uploaded without inline content (large pastes)."""
        kb = a.size / 1024
        size_str = f"{kb:.0f}KB" if kb < 1024 else f"{kb / 1024:.1f}MB"
        return (
            f"\nText file \"{a.name}\" ({size_str}) saved: {a.path}\n"
            "Use read_file with offset and limit for paginated reading "
            "(e.g. offset=1, limit=200). Do not read the entire file at once."
        )

    use_vision = any(img.data_url for img in images)

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
                text_parts.append(f"\nFile available at: {bf.path}\n(use read_file or bash_tool to read it)")
        for img in images:
            if img.path:
                text_parts.append(
                    f"\nImage \"{img.name}\" saved: {img.path}\n"
                    "(readable/processable via bash_tool — convert, "
                    "ffmpeg, python+PIL, etc.)"
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

    # No inline-able images (none attached, or attached without a data URL) —
    # plain text with file paths. Model can still operate on images by path.
    parts: list[str] = [header]
    for tf in inline_files:
        parts.append(f"\n--- {tf.name} ---\n{tf.content}")
    for of_ in offloaded_files:
        parts.append(_fmt_offloaded(of_))
    for bf in binary_files:
        parts.append(f"\nFile available at: {bf.path}\n(use read_file or bash_tool to read it)")
    for img in images:
        if img.path:
            parts.append(
                f"\nImage \"{img.name}\": {img.path}\n(use bash_tool to process)"
            )
    parts.append(f"\n---\n{text}")
    return "\n".join(parts)


# Total budget for extracted project-file text injected into the system prompt.
# Bounds token cost when a project carries many or large documents.
_PROJECT_TEXT_BUDGET = 60_000


def _sandbox_file_path(chat_dir: str, name: str, shell: str) -> str:
    """Where an un-extracted project file lands inside the chat sandbox."""
    if shell == "powershell":
        return f"{chat_dir}\\project_files\\{name}"
    return f"{chat_dir}/project_files/{name}"


async def _sync_unextracted_to_sandbox(
    files: list[dict[str, Any]], chat_dir: str, shell: str
) -> None:
    """Copy project files that couldn't be auto-extracted into the chat sandbox
    (``project_files/``) so the model can open them with read_file / bash.

    Best-effort: a copy failure just means that one file won't be reachable —
    the rest of the turn still proceeds.
    """
    if not chat_dir:
        return
    for f in files:
        disk_path = f.get("disk_path") or ""
        if not disk_path:
            continue
        try:
            data = await asyncio.to_thread(Path(disk_path).read_bytes)
        except OSError:
            continue
        target = _sandbox_file_path(chat_dir, f["name"], shell)
        try:
            if shell == "powershell":
                p = Path(target)
                await asyncio.to_thread(p.parent.mkdir, parents=True, exist_ok=True)
                await asyncio.to_thread(p.write_bytes, data)
            else:
                await wsl_write_bytes(target, data)
        except Exception:  # noqa: BLE001 — fallback copy is non-critical
            continue


def _build_project_block(project: dict[str, Any], chat_dir: str, shell: str) -> str:
    """Render the project's instructions + extracted file text as a system-prompt
    block. Un-extracted files are listed by their in-sandbox path so the model
    can open them itself."""
    name = project.get("name", "")
    instructions = (project.get("instructions") or "").strip()
    files = project.get("files", [])

    lines: list[str] = [
        f"# Project: {name}",
        "This chat belongs to a project. Follow the project instructions and "
        "refer to its files throughout the conversation.",
    ]
    if instructions:
        lines.append("\n## Project instructions")
        lines.append(instructions)

    ok_files = [
        f for f in files
        if f.get("extract_status") == "ok" and (f.get("extracted_text") or "").strip()
    ]
    other_files = [f for f in files if f.get("extract_status") != "ok"]

    if ok_files:
        lines.append(
            "\n## Project files (text already extracted — do NOT re-read them)"
        )
        budget = _PROJECT_TEXT_BUDGET
        for f in ok_files:
            text = f.get("extracted_text") or ""
            if budget <= 0:
                lines.append(f"\n--- {f['name']} ---\n[skipped: context budget exhausted]")
                continue
            if len(text) > budget:
                text = text[:budget] + "\n[...truncated]"
            budget -= len(text)
            lines.append(f"\n--- {f['name']} ---\n{text}")

    if other_files:
        lines.append(
            "\n## Project files without auto-extraction (open manually when needed)"
        )
        lines.append(
            "Text from these files could not be extracted automatically. They have been copied "
            "to the working folder — read them via read_file or bash_tool:"
        )
        for f in other_files:
            path = _sandbox_file_path(chat_dir, f["name"], shell) if chat_dir else f["name"]
            lines.append(f"- \"{f['name']}\" → {path}")

    return "\n".join(lines)


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
    extra_headers = provider.extra_headers if provider else None

    # OpenAI-compatible endpoints carry OUR provider id as the prefix, which
    # LiteLLM can't route — re-tag them as `openai/<model>`. Shared with the
    # research model path (see llm.model_tag) so the two never drift apart.
    lite_model, api_key = retag_model_for_litellm(provider, model, api_key)

    # Resolve thinking control
    model_cfg = store.get_model_config(model)
    extra_body: dict[str, Any] | None = None
    if body.thinking_enabled is False:
        extra_body = {"thinking": {"type": "disabled"}}
    elif model_cfg is not None and model_cfg.thinking is False:
        extra_body = {"thinking": {"type": "disabled"}}

    if body.effort and model_cfg is not None and model_cfg.effort_levels:
        if body.effort in model_cfg.effort_levels:
            if extra_body is None:
                extra_body = {}
            extra_body["reasoning_effort"] = body.effort

    # Build fresh system prompt (includes current date + model identity +
    # artifact instructions). The model id goes in so the assistant knows
    # which LLM it is when asked.
    #
    # An attached agent whose system_prompt is non-empty REPLACES this
    # entirely — the agent editor warns the user about the risk, and the
    # skills manifest / project block are still appended after either way
    # (see agent.loop._build_messages), so those keep working regardless.
    from api.schemas.agents import DEFAULT_AGENT_ID

    agent = store.get_agent(body.agent_id or DEFAULT_AGENT_ID) or store.get_agent(DEFAULT_AGENT_ID)
    if agent is not None and agent.system_prompt.strip():
        system_prompt: str = agent.system_prompt
    else:
        system_prompt = app_state.system_prompt_factory(model)

    # Fresh tool set per request: each call stamps its sandbox policy onto the
    # filesystem tools, and multiple chats can now stream at once — sharing one
    # set would let their policies race. See tools.factory.build_tool_registry.
    from tools.factory import build_tool_registry

    base_registry: ToolRegistry = build_tool_registry(app_state.skill_reader)
    mcp_proxies = await _build_mcp_proxies(
        body.mcp_enabled_servers, store, app_state.mcp_manager
    )

    # ── web search wiring ───────────────────────────────────────────────
    # Resolve the fallback chain (native → litellm/Tavily → searxng → none).
    # Native = a provider-side tool appended to the LiteLLM tools array; the
    # local backends = a `web_search` function-tool overlaid on the registry.
    from store.settings_store import build_web_search_config

    overlay_tools: list[BaseTool] = list(mcp_proxies)
    native_web_tools: list[dict[str, Any]] = []
    web_search_effective = "none"
    provider_id = provider.id if provider else ""

    # One id per user turn — ties every LLM call this turn makes (main loop +
    # any research sub-calls) to a single usage_log aggregate. See
    # docs/agentchat-usage-tracking-design.md.
    message_id = str(uuid.uuid4())
    usage_metadata: dict[str, Any] = {
        "chat_id": body.chat_id or "",
        "message_id": message_id,
        "provider": provider_id or "unknown",
        "canonical_model": model,
        "context": "chat",
    }
    if body.web_search_enabled:
        ws_service = app_state.web_search_service
        ws_config = build_web_search_config(store)
        requested = body.web_search_mode or store.web_search_mode
        resolved = ws_service.resolve(provider_id, model, requested, ws_config)
        web_search_effective = resolved.effective
        if resolved.effective == "native" and resolved.native_tool:
            native_web_tools = [resolved.native_tool]
        elif resolved.effective in ("litellm", "searxng"):
            overlay_tools.append(WebSearchTool(ws_service, ws_config, resolved.effective))

    # ── research wiring ─────────────────────────────────────────────────
    # Deep multi-step research is a separate `research` tool, gated by its own
    # sticky toggle and run on its own model. It resolves a web backend itself
    # (independently of the chat model + web-search toggle above).
    research_on = (
        body.research_enabled if body.research_enabled is not None else store.research_enabled
    )
    if research_on:
        research_model = store.research_model or store.default_model
        r_provider = store.get_provider(research_model)
        r_api_key = r_provider.api_key if r_provider else None
        r_api_base = r_provider.api_base if r_provider else None
        r_extra_headers = r_provider.extra_headers if r_provider else None
        r_lite_model, r_api_key = retag_model_for_litellm(r_provider, research_model, r_api_key)
        overlay_tools.append(
            ResearchTool(
                store=store,
                web_search_service=app_state.web_search_service,
                provider_id=r_provider.id if r_provider else "",
                model=research_model,
                lite_model=r_lite_model,
                api_key=r_api_key,
                api_base=r_api_base,
                extra_headers=r_extra_headers,
                usage_metadata={
                    **usage_metadata,
                    "provider": r_provider.id if r_provider else "unknown",
                    "canonical_model": research_model,
                },
            )
        )
        system_prompt = f"{system_prompt}\n\n{_RESEARCH_NUDGE}"

    registry: ToolRegistry = (
        MCPAwareRegistry(base_registry, overlay_tools) if overlay_tools else base_registry
    )

    # Build the per-chat sandbox policy and push it into every tool that can
    # touch the filesystem. In restricted mode bash_tool is wrapped with bwrap
    # and read/write tools refuse paths outside their allowed scope.
    from paths import (
        USER_HOME,
        USER_NAME,
        WSL_USER_HOME,
        get_allowed_read_prefixes,
        get_blocked_read_prefixes,
    )
    active_shell = resolve_active_shell(store.shell_preference)
    # WSL has its own synthetic home (/home/<user>); PowerShell and native POSIX
    # both use the real OS home.
    home = WSL_USER_HOME if active_shell == "wsl" else USER_HOME
    chat_dir = _resolve_chat_cwd(body.chat_dir_slug, home, shell=active_shell)

    # Project context: the project's instructions + extracted file text, kept
    # OUT of system_prompt (unlike before) so the usage breakdown can report it
    # as its own "memory files" bucket instead of folding it into "system
    # prompt". Applied to the agent via set_project_context() below. Also
    # copies any un-extracted files into the sandbox so the model can still
    # open them by hand. Done after chat_dir is known.
    project_block = ""
    if body.project_id:
        project_ctx = app_state.project_store.get_project_context(body.project_id)
        if project_ctx:
            unextracted = [
                f for f in project_ctx.get("files", [])
                if f.get("extract_status") != "ok"
            ]
            await _sync_unextracted_to_sandbox(unextracted, chat_dir, active_shell)
            project_block = _build_project_block(project_ctx, chat_dir, active_shell)

    config = AgentConfig(
        model=lite_model,
        system_prompt=system_prompt,
        api_key=api_key,
        api_base=api_base,
        temperature=store.temperature,
        max_iterations=store.max_iterations,
        extra_body=extra_body,
        extra_headers=extra_headers,
        describe_actions=store.describe_actions,
    )

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
    write = registry.get(WriteFileTool.name)
    if isinstance(write, WriteFileTool):
        write.set_policy(policy)
    edit = registry.get(EditFileTool.name)
    if isinstance(edit, EditFileTool):
        edit.set_policy(policy)
    present = registry.get(PresentFilesTool.name)
    if isinstance(present, PresentFilesTool):
        present.set_policy(policy)
    research = registry.get(ResearchTool.name)
    if isinstance(research, ResearchTool):
        research.set_policy(policy)

    llm = LLMClient(api_base=config.api_base, api_key=config.api_key, extra_headers=config.extra_headers)
    agent = AgentLoop(
        config=config,
        tools=registry,
        llm=llm,
        policy=policy,
        extra_tools=native_web_tools or None,
        chat_id=body.chat_id or "",
        usage_metadata=usage_metadata,
    )
    app_state.skill_reader.rebuild()
    agent.set_manifest(app_state.skill_reader.render_prompt())
    if project_block:
        agent.set_project_context(project_block)

    agent.messages.extend(build_agent_messages(history))

    user_content = _format_user_content(new_message, body.attachments)

    async def event_stream() -> Any:
        # Announce the effective web-search backend up front so the UI can badge
        # the assistant message (mode + later, result count from the tool step).
        if web_search_effective != "none":
            yield _sse_event("web_search_status", {"mode": web_search_effective})
        try:
            async for event in agent.run_stream(user_content):
                yield _sse_event(event["type"], event)
            # The usage/cost logging callback (llm/usage_logging.py) writes
            # asynchronously via LiteLLM's own logging task, so the row(s) for
            # this turn may not be committed yet — poll briefly rather than
            # block the whole response on it.
            usage_store = app_state.usage_store
            for attempt in range(6):
                usage = usage_store.get_message_usage(message_id)
                if usage is not None:
                    yield _sse_event("usage", {**usage, "message_id": message_id})
                    break
                await asyncio.sleep(0.05 * (attempt + 1))
        except Exception as exc:
            # Native search is optimistic for some providers (e.g. OpenAI). If the
            # provider rejected the native tool, remember that so the next turn
            # falls back down the chain instead of failing again.
            if web_search_effective == "native":
                app_state.web_search_service.mark_native_unsupported(provider_id, model)
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
