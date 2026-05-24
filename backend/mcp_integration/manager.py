"""Process supervisor for MCP servers.

The manager owns connections on demand: it spawns a server the first time
a chat asks for one of its tools, keeps it alive for follow-up calls, and
reaps it after a configurable idle window. All public methods are async
and safe to call from FastAPI handlers.

The reaper task is a single background coroutine launched from
:meth:`MCPManager.start` and cancelled on :meth:`MCPManager.shutdown`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from mcp_integration.client import open_session
from mcp_integration.config import MCPServerConfig

if TYPE_CHECKING:
    from mcp import ClientSession

logger = logging.getLogger(__name__)

# How often the reaper wakes up to look for idle handles.
_REAPER_INTERVAL_S = 30.0
# How long a handle may sit unused before being torn down.
_IDLE_TIMEOUT_S = 300.0
# Maximum time we wait for a server to initialise / call a tool.
_OP_TIMEOUT_S = 30.0


@dataclass
class _ToolInfo:
    """A tool advertised by an MCP server."""

    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class _Handle:
    """In-memory state for one running MCP server."""

    server_id: str
    session: ClientSession
    stack: AsyncExitStack
    tools: list[_ToolInfo]
    last_used: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class MCPServerStatus:
    """Snapshot of a server's runtime state — exposed via the API."""

    server_id: str
    state: str  # "stopped" | "running" | "error"
    last_error: str | None
    tools: list[dict[str, Any]]
    last_used: float | None


class MCPManager:
    """Lazy supervisor — connects on demand, evicts after idle timeout."""

    def __init__(
        self,
        idle_timeout_s: float = _IDLE_TIMEOUT_S,
        reaper_interval_s: float = _REAPER_INTERVAL_S,
    ) -> None:
        self._handles: dict[str, _Handle] = {}
        self._errors: dict[str, str] = {}
        # Each server gets its own spawn-lock so two concurrent chats don't
        # race to spawn the same server.
        self._spawn_locks: dict[str, asyncio.Lock] = {}
        self._idle_timeout_s = idle_timeout_s
        self._reaper_interval_s = reaper_interval_s
        self._reaper_task: asyncio.Task[None] | None = None
        self._shutdown = False

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Launch the background reaper task."""
        if self._reaper_task is None:
            self._reaper_task = asyncio.create_task(self._reaper_loop(), name="mcp-reaper")

    async def shutdown(self) -> None:
        """Tear down every running handle and stop the reaper."""
        self._shutdown = True
        if self._reaper_task is not None:
            self._reaper_task.cancel()
            try:
                await self._reaper_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reaper_task = None
        for server_id in list(self._handles):
            await self._tear_down(server_id, reason="shutdown")

    # ------------------------------------------------------------------
    # public surface
    # ------------------------------------------------------------------

    async def ensure_started(self, cfg: MCPServerConfig) -> list[_ToolInfo]:
        """Ensure the server is running and return its discovered tools.

        Concurrent callers waiting on the same server_id share one spawn —
        the second arrival blocks on the spawn-lock and re-uses the first's
        session.
        """
        if not cfg.enabled:
            raise RuntimeError(f"MCP server '{cfg.id}' is disabled")

        lock = self._spawn_locks.setdefault(cfg.id, asyncio.Lock())
        async with lock:
            handle = self._handles.get(cfg.id)
            if handle is not None:
                handle.last_used = time.monotonic()
                return list(handle.tools)
            try:
                handle = await self._spawn(cfg)
            except Exception as exc:
                msg = str(exc) or exc.__class__.__name__
                self._errors[cfg.id] = msg
                logger.warning("MCP server %s failed to start: %s", cfg.id, msg)
                raise
            self._handles[cfg.id] = handle
            self._errors.pop(cfg.id, None)
            return list(handle.tools)

    async def call_tool(
        self,
        cfg: MCPServerConfig,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> str:
        """Invoke a tool on the named server. Returns a textual result."""
        await self.ensure_started(cfg)
        handle = self._handles[cfg.id]
        async with handle.lock:
            handle.last_used = time.monotonic()
            try:
                result = await asyncio.wait_for(
                    handle.session.call_tool(tool_name, arguments=arguments),
                    timeout=_OP_TIMEOUT_S,
                )
            except asyncio.TimeoutError as exc:
                raise RuntimeError(
                    f"MCP tool '{tool_name}' timed out after {_OP_TIMEOUT_S:.0f}s"
                ) from exc
        return _format_call_result(result)

    async def list_tools_fresh(self, cfg: MCPServerConfig) -> list[_ToolInfo]:
        """Force a re-spawn (or first spawn) and return the latest tool set."""
        if cfg.id in self._handles:
            await self._tear_down(cfg.id, reason="manual refresh")
        return await self.ensure_started(cfg)

    def get_status(self, server_id: str) -> MCPServerStatus:
        """Snapshot of a server's runtime state — for the UI."""
        handle = self._handles.get(server_id)
        if handle is not None:
            return MCPServerStatus(
                server_id=server_id,
                state="running",
                last_error=None,
                tools=[_tool_to_dict(t) for t in handle.tools],
                last_used=handle.last_used,
            )
        err = self._errors.get(server_id)
        return MCPServerStatus(
            server_id=server_id,
            state="error" if err else "stopped",
            last_error=err,
            tools=[],
            last_used=None,
        )

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    async def _spawn(self, cfg: MCPServerConfig) -> _Handle:
        stack = AsyncExitStack()
        try:
            session = await asyncio.wait_for(
                open_session(cfg, stack), timeout=_OP_TIMEOUT_S
            )
            tools_response = await asyncio.wait_for(
                session.list_tools(), timeout=_OP_TIMEOUT_S
            )
        except Exception:
            await stack.aclose()
            raise

        tools = [
            _ToolInfo(
                name=t.name,
                description=t.description or "",
                input_schema=_normalise_schema(t.inputSchema),
            )
            for t in tools_response.tools
        ]
        logger.info(
            "MCP server %s started: %d tool(s) [%s]",
            cfg.id,
            len(tools),
            ", ".join(t.name for t in tools),
        )
        return _Handle(
            server_id=cfg.id,
            session=session,
            stack=stack,
            tools=tools,
            last_used=time.monotonic(),
        )

    async def _tear_down(self, server_id: str, *, reason: str) -> None:
        handle = self._handles.pop(server_id, None)
        if handle is None:
            return
        logger.info("MCP server %s stopping (%s)", server_id, reason)
        try:
            await handle.stack.aclose()
        except Exception:  # noqa: BLE001
            logger.warning("MCP server %s shutdown raised", server_id, exc_info=True)

    async def _reaper_loop(self) -> None:
        try:
            while not self._shutdown:
                await asyncio.sleep(self._reaper_interval_s)
                if self._shutdown:
                    return
                now = time.monotonic()
                for server_id, handle in list(self._handles.items()):
                    if now - handle.last_used >= self._idle_timeout_s:
                        await self._tear_down(server_id, reason="idle timeout")
        except asyncio.CancelledError:
            raise


def _normalise_schema(raw: Any) -> dict[str, Any]:
    """Coerce a tool's ``inputSchema`` into an OpenAI-compatible JSON Schema.

    MCP guarantees JSON Schema but allows ``None`` for parameter-less tools.
    LiteLLM rejects that, so we substitute the empty-object schema.
    """
    if isinstance(raw, dict) and raw:
        return raw
    return {"type": "object", "properties": {}, "required": []}


def _tool_to_dict(t: _ToolInfo) -> dict[str, Any]:
    return {
        "name": t.name,
        "description": t.description,
        "input_schema": t.input_schema,
    }


def _format_call_result(result: Any) -> str:
    """Flatten a ``CallToolResult`` into a printable string for the agent.

    The MCP SDK returns a structured object with ``content`` blocks and an
    ``isError`` flag. The agent loop expects a flat string — we concatenate
    text blocks, prefix the error flag, and stringify everything else.
    """
    parts: list[str] = []
    is_error = bool(getattr(result, "isError", False))
    content = getattr(result, "content", None) or []
    for block in content:
        # Text blocks carry the bulk of normal responses.
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
            continue
        # Resource / image blocks — keep them visible but compact.
        block_type = getattr(block, "type", block.__class__.__name__)
        parts.append(f"[{block_type} block — non-text content omitted]")

    body = "\n".join(parts).strip() or "(no content)"
    if is_error:
        return f"Error from MCP tool: {body}"
    return body
