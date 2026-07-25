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
    """In-memory state for one running MCP server.

    ``owner`` is the task that entered the session's ``AsyncExitStack`` and is
    the only task allowed to exit it (see :meth:`MCPManager._own_session`).
    Tearing down means setting ``close_event`` and awaiting ``owner`` — never
    closing the stack from here.
    """

    server_id: str
    session: ClientSession
    tools: list[_ToolInfo]
    last_used: float
    owner: asyncio.Task[None]
    close_event: asyncio.Event
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
        handle = await self._acquire(cfg)
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

    async def _acquire(self, cfg: MCPServerConfig) -> _Handle:
        """Start the server if needed and return its live handle.

        ``ensure_started`` releases the spawn lock before returning, so a
        tear-down (idle reap, manual refresh, shutdown) can land between it and
        the lookup — indexing ``_handles`` blindly raised KeyError there. One
        retry covers that window; a second miss means the server really is gone.
        """
        for _ in range(2):
            await self.ensure_started(cfg)
            handle = self._handles.get(cfg.id)
            if handle is not None:
                return handle
        raise RuntimeError(
            f"MCP server '{cfg.id}' kept stopping before the call could be made"
        )

    async def list_tools_fresh(self, cfg: MCPServerConfig) -> list[_ToolInfo]:
        """Force a re-spawn (or first spawn) and return the latest tool set."""
        # Hold the spawn lock across the tear-down so a concurrent
        # ensure_started can't install a fresh handle that we then reap.
        lock = self._spawn_locks.setdefault(cfg.id, asyncio.Lock())
        async with lock:
            await self._tear_down(cfg.id, reason="manual refresh")
        return await self.ensure_started(cfg)

    async def stop(self, server_id: str, *, reason: str) -> None:
        """Public tear-down — used by the routes when config changes or the
        server is deleted. Held under the spawn lock so it can't race a spawn
        that is already in flight."""
        lock = self._spawn_locks.setdefault(server_id, asyncio.Lock())
        async with lock:
            await self._tear_down(server_id, reason=reason)

    def forget(self, server_id: str) -> None:
        """Drop bookkeeping for a server the user deleted from settings.

        The handle itself is reaped separately; this only clears the per-id
        lock and error entries so they don't accumulate for the process's life.
        """
        self._spawn_locks.pop(server_id, None)
        self._errors.pop(server_id, None)

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

    async def _own_session(
        self,
        cfg: MCPServerConfig,
        ready: asyncio.Future[tuple[ClientSession, list[_ToolInfo]]],
        close_event: asyncio.Event,
    ) -> None:
        """Own one server's ``AsyncExitStack`` for the whole of its lifetime.

        The MCP SDK's transports are anyio-based, and anyio binds a cancel
        scope to the task that entered it. Entering the stack in a request
        handler and closing it from the reaper — a different task — raises
        ``Attempted to exit cancel scope in a different task``; the manager
        logged that and moved on, leaving the subprocess running forever. So
        the stack is opened *and* closed here, in one task, and tear-down is a
        signal (``close_event``) rather than a foreign ``aclose()``.
        """
        try:
            async with AsyncExitStack() as stack:
                session = await asyncio.wait_for(
                    open_session(cfg, stack), timeout=_OP_TIMEOUT_S
                )
                tools_response = await asyncio.wait_for(
                    session.list_tools(), timeout=_OP_TIMEOUT_S
                )
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
                if ready.done():
                    # The spawner gave up (timed out / was cancelled) — unwind
                    # rather than leaving an unreachable server running.
                    return
                ready.set_result((session, tools))
                await close_event.wait()
        except asyncio.CancelledError:
            if not ready.done():
                ready.cancel()
            raise
        except Exception as exc:  # noqa: BLE001 — reported via `ready` or the log
            if not ready.done():
                ready.set_exception(exc)
            else:
                logger.warning(
                    "MCP server %s session ended with an error", cfg.id, exc_info=True
                )

    async def _spawn(self, cfg: MCPServerConfig) -> _Handle:
        loop = asyncio.get_running_loop()
        ready: asyncio.Future[tuple[ClientSession, list[_ToolInfo]]] = loop.create_future()
        close_event = asyncio.Event()
        owner = asyncio.create_task(
            self._own_session(cfg, ready, close_event), name=f"mcp-session-{cfg.id}"
        )
        try:
            # `ready` is a plain future, so a timeout here does not cancel the
            # owner task — signal it instead and let it unwind its own stack.
            session, tools = await asyncio.wait_for(ready, timeout=_OP_TIMEOUT_S)
        except BaseException:
            close_event.set()
            owner.cancel()
            raise
        return _Handle(
            server_id=cfg.id,
            session=session,
            tools=tools,
            last_used=time.monotonic(),
            owner=owner,
            close_event=close_event,
        )

    async def _tear_down(self, server_id: str, *, reason: str) -> None:
        handle = self._handles.pop(server_id, None)
        if handle is None:
            return
        logger.info("MCP server %s stopping (%s)", server_id, reason)
        # The handle is already unreachable, so no new call can join. Wait for
        # an in-flight call_tool to finish rather than yanking the session out
        # from under it — the call is itself bounded by _OP_TIMEOUT_S.
        async with handle.lock:
            handle.close_event.set()
            try:
                await asyncio.wait_for(handle.owner, timeout=_OP_TIMEOUT_S)
            except asyncio.TimeoutError:
                # wait_for already cancelled the owner; it unwinds on its own.
                logger.warning(
                    "MCP server %s did not stop within %.0fs — cancelled",
                    server_id, _OP_TIMEOUT_S,
                )
            except asyncio.CancelledError:
                raise
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
