"""CRUD for chat sessions persisted in SQLite."""

from __future__ import annotations

import re
import shlex
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from agent.wsl_exec import wsl_run

router = APIRouter(prefix="/chats", tags=["chats"])

# Same pattern as api/chat.py — keeps shell injection out of rm -rf.
# Slugs created by the UI are "chat-<short>-<timestamp>"; require the prefix
# explicitly so a malicious or buggy client can't pass "." / ".." / "" / "/".
_SAFE_SLUG_RE = re.compile(r"^chat-[a-z0-9][a-z0-9_\-]{0,62}$")


async def _purge_chat_dir(dir_slug: str) -> None:
    """Remove the WSL working folder for a chat. Silent on failure — the DB row
    is already gone and a stale folder is recoverable, but raising here would
    surface as a 500 even though the chat itself was deleted.

    Defense-in-depth against rm -rf accidents:
      1. Python-side regex: slug must start with ``chat-`` and contain only
         ``[a-z0-9_-]``. Rejects "..", "/", empty, absolute paths.
      2. Shell-side ``case`` guard: only proceeds if the resolved path starts
         with ``$HOME/AgentChat/chats/chat-``. A regex bypass would still hit
         this check and exit without touching anything.
    """
    if not dir_slug or not _SAFE_SLUG_RE.match(dir_slug):
        return
    slug_q = shlex.quote(dir_slug)
    cmd = (
        f"target=\"$HOME/AgentChat/chats/$( printf %s {slug_q} )\"; "
        f"case \"$target\" in \"$HOME/AgentChat/chats/chat-\"*) "
        f"  rm -rf -- \"$target\" ;; "
        f"esac"
    )
    try:
        await wsl_run(cmd, timeout=30)
    except Exception:
        pass


class ChatSummary(BaseModel):
    """Lightweight chat entry for the sidebar list."""

    id: str
    title: str
    dir_slug: str
    created_at: int
    updated_at: int


class ChatFull(ChatSummary):
    """A chat with its full message tree included."""

    root: list[Any] = Field(default_factory=list)


class ChatCreate(BaseModel):
    """Payload for creating a new chat. Server trusts client-supplied id+slug."""

    id: str = Field(min_length=1, max_length=128)
    title: str = ""
    dir_slug: str = ""
    root: list[Any] = Field(default_factory=list)
    created_at: int | None = None


class ChatUpdate(BaseModel):
    """Partial update — any subset of mutable fields."""

    title: str | None = None
    dir_slug: str | None = None
    root: list[Any] | None = None


@router.get("", response_model=list[ChatSummary])
async def list_chats(request: Request) -> list[ChatSummary]:
    rows = request.app.state.chat_store.list_chats()
    return [ChatSummary(**r) for r in rows]


@router.get("/{chat_id}", response_model=ChatFull)
async def get_chat(request: Request, chat_id: str) -> ChatFull:
    row = request.app.state.chat_store.get_chat(chat_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    return ChatFull(**row)


@router.post("", response_model=ChatFull)
async def create_chat(request: Request, body: ChatCreate) -> ChatFull:
    store = request.app.state.chat_store
    # Idempotent: if the chat already exists (e.g. retry of a failed migration),
    # treat it as an upsert rather than 409. Avoids dead-end errors for clients.
    row = store.upsert_chat(
        chat_id=body.id,
        title=body.title,
        dir_slug=body.dir_slug,
        root=body.root,
        created_at=body.created_at,
    )
    return ChatFull(**row)


@router.put("/{chat_id}", response_model=ChatFull)
async def update_chat(request: Request, chat_id: str, body: ChatUpdate) -> ChatFull:
    row = request.app.state.chat_store.update_chat(
        chat_id=chat_id,
        title=body.title,
        dir_slug=body.dir_slug,
        root=body.root,
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    return ChatFull(**row)


@router.delete("/{chat_id}")
async def delete_chat(request: Request, chat_id: str) -> dict[str, str]:
    store = request.app.state.chat_store
    # Snapshot the slug before deleting so we know which folder to purge.
    row = store.get_chat(chat_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    if not store.delete_chat(chat_id):
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    await _purge_chat_dir(row.get("dir_slug") or "")
    return {"status": "ok"}
