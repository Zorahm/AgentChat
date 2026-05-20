"""Aggregates all route routers into a single api_router for main.py."""

from __future__ import annotations

from fastapi import APIRouter

from api.chat import router as chat_router
from api.chats import router as chats_router
from api.files import router as files_router
from api.health import router as health_router
from api.models_routes import router as models_router
from api.settings import router as settings_router
from api.skills import router as skills_router
from api.wsl import router as wsl_router

api_router = APIRouter(prefix="/api")
api_router.include_router(chat_router)
api_router.include_router(chats_router)
api_router.include_router(files_router)
api_router.include_router(skills_router)
api_router.include_router(settings_router)
api_router.include_router(models_router)
api_router.include_router(health_router)
api_router.include_router(wsl_router)
