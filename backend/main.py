"""FastAPI application entrypoint — composition root.

Usage::

    set OPENAI_API_KEY=sk-...
    uvicorn main:app --host 127.0.0.1 --port 8787

The actual logic lives in focused modules — ``paths`` (locations/identity),
``shell`` (WSL vs PowerShell), ``agent.system_prompt`` (prompt), ``tools.factory``
(tool registry), ``store.settings_store`` (persisted settings). This file only
wires them into a FastAPI app.
"""

from __future__ import annotations

import asyncio
import ipaddress
import secrets
import sys
from contextlib import asynccontextmanager
from typing import Any, Callable

# On Windows, asyncio.create_subprocess_exec only works under
# ProactorEventLoop. Uvicorn's default loop selection sometimes hands us a
# SelectorEventLoop, which then raises NotImplementedError() with an empty
# message when we try to spawn wsl.exe — that surfaces as a silent failure
# in the UI ("error" icon + empty output). Force the right policy at import
# time so the policy is set before uvicorn builds its loop.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from agent.system_prompt import build_system_prompt
from api.router import api_router
from llm.models_fetcher import ModelsFetcher
from mcp_integration import MCPManager
from paths import (
    BUILD_VERSION,
    CHAT_DB_FILE,
    PROJECT_DB_FILE,
    SETTINGS_FILE,
    USER_AGENTS_SKILLS_DIR,
    resolve_ui_dist,
)
from shell import resolve_active_shell
from skills.installer import GitHubSkillInstaller
from skills.reader import AgentSkillsReader
from store.chat_store import ChatStore
from store.project_store import ProjectStore
from store.settings_store import SettingsStore
from tools.factory import build_tool_registry
from web_search.service import WebSearchService

_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_loopback_client(request: Request) -> bool:
    """True when the request originates from this machine (the desktop app).

    Loopback clients are exempt from remote-access token checks; everything
    else (LAN / Tailscale / phone) must present the Bearer token.
    """
    client = request.client
    if client is None:
        return False
    host = client.host or ""
    if host in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# app factory
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    """Build the FastAPI application with all routers and state."""

    USER_AGENTS_SKILLS_DIR.mkdir(parents=True, exist_ok=True)

    # --- stateful singletons ---
    # All installs and scans use ~/.agents/skills/ — the shared Agent Skills
    # convention path — so dev, PyInstaller, terminal, and other agents see
    # the same set.
    reader = AgentSkillsReader(USER_AGENTS_SKILLS_DIR)
    reader.rebuild()

    installer = GitHubSkillInstaller(USER_AGENTS_SKILLS_DIR, reader)
    models_fetcher = ModelsFetcher()
    settings_store = SettingsStore(fetcher=models_fetcher, settings_path=SETTINGS_FILE)
    chat_store = ChatStore(CHAT_DB_FILE)
    project_store = ProjectStore(PROJECT_DB_FILE)

    # --- tools ---
    # Startup set is kept on app.state for introspection; /api/chat builds its
    # own fresh set per request so concurrent chats don't share tool policy.
    registry = build_tool_registry(reader)

    # --- web search (native capability cache + Tavily/SearXNG client) ---
    def _native_web_search_cap(model_id: str) -> bool | None:
        cached = models_fetcher.get_cached_model(model_id)
        return cached.web_search if cached else None

    web_search_service = WebSearchService(capability_lookup=_native_web_search_cap)

    # --- MCP manager (lazy-spawn supervisor for external MCP servers) ---
    mcp_manager = MCPManager()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> Any:
        await mcp_manager.start()
        try:
            yield
        finally:
            await mcp_manager.shutdown()

    app = FastAPI(
        title="AgentChat",
        version="0.2.0",
        lifespan=lifespan,
    )

    # --- CORS (allow Vite dev server + Tauri webview) ---
    # Tauri v2 on Windows serves the webview from http://tauri.localhost (HTTP).
    # macOS/Linux use https://tauri.localhost or the tauri:// custom scheme.
    # If the production scheme is missing here, fetch() in the installed app
    # is blocked by the browser and the UI hangs on "Loading..." forever.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        allow_origin_regex=r"^(tauri|https?)://(.*\.)?tauri\.localhost$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # --- remote access guard ---
    # Protects /api/* only. The static SPA shell stays public so a phone can
    # load index.html (and read its ?token=) before it has a token to send.
    # Loopback (the local desktop app) is always exempt; any other origin must
    # present the Bearer token, and only while remote access is enabled.
    @app.middleware("http")
    async def remote_access_guard(request: Request, call_next: Callable) -> Any:
        path = request.url.path
        if request.method != "OPTIONS" and path.startswith("/api/") and not _is_loopback_client(
            request
        ):
            store = request.app.state.settings_store
            if not store.remote_access_enabled:
                return JSONResponse(
                    {"detail": "Remote access is disabled on this backend."},
                    status_code=401,
                )
            expected = store.remote_token
            header = request.headers.get("authorization", "")
            token = header[7:].strip() if header[:7].lower() == "bearer " else ""
            if not expected or not token or not secrets.compare_digest(token, expected):
                return JSONResponse(
                    {"detail": "Invalid or missing remote access token."},
                    status_code=401,
                )
        return await call_next(request)

    # --- attach state for route handlers ---
    app.state.skill_reader = reader
    app.state.skill_installer = installer
    app.state.settings_store = settings_store
    app.state.chat_store = chat_store
    app.state.project_store = project_store
    app.state.models_fetcher = models_fetcher
    app.state.tool_registry = registry
    app.state.mcp_manager = mcp_manager
    app.state.web_search_service = web_search_service
    app.state.system_prompt_factory: Callable[[str], str] = lambda model="": build_system_prompt(
        user_name=settings_store.user_name,
        shell=resolve_active_shell(settings_store.shell_preference),
        model=model,
    )

    # --- routers ---
    app.include_router(api_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        # `version` lets the desktop shell verify the backend on 8787 is the one
        # this build ships, not a stale sidecar from a previous version.
        return {"status": "ok", "version": BUILD_VERSION}

    # --- static UI (remote/phone clients) ---
    # Serve the built SPA from the same origin as the API so phones never hit
    # CORS. Mounted last so /api/* routes always win. Skipped when no build
    # exists (dev uses Vite; the desktop webview uses its own bundle).
    ui_dist = resolve_ui_dist()
    if ui_dist is not None:
        app.mount("/", StaticFiles(directory=str(ui_dist), html=True), name="ui")

    return app


app = create_app()
