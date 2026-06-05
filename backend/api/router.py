"""Aggregates all route routers into a single api_router for main.py."""

from __future__ import annotations

from fastapi import APIRouter

from api.chat import router as chat_router
from api.chats import router as chats_router
from api.config_routes import router as config_router
from api.files import router as files_router
from api.health import router as health_router
from api.mcp import router as mcp_router
from api.models_routes import router as models_router
from api.projects import router as projects_router
from api.remote import router as remote_router
from api.searxng import router as searxng_router
from api.settings import router as settings_router
from api.skills import router as skills_router
from api.win_deps import router as win_deps_router
from api.wsl import router as wsl_router

api_router = APIRouter(prefix="/api")
api_router.include_router(chat_router)
api_router.include_router(chats_router)
api_router.include_router(projects_router)
api_router.include_router(files_router)
api_router.include_router(skills_router)
api_router.include_router(settings_router)
api_router.include_router(remote_router)
api_router.include_router(models_router)
api_router.include_router(mcp_router)
api_router.include_router(health_router)
api_router.include_router(wsl_router)
api_router.include_router(win_deps_router)
api_router.include_router(config_router)
api_router.include_router(searxng_router)
