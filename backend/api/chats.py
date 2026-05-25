"""CRUD for chat sessions persisted in SQLite."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from agent.wsl_exec import decode_loose, wsl_run

# On Windows, hide the CMD window when spawning npm in a new console.
_NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # 0x08000000

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chats", tags=["chats"])

# Must be at least as permissive as api/chat.py _SLUG_RE so that every
# slug accepted at creation time is also accepted at deletion time.
_SAFE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")


def _default_wsl_home() -> str | None:
    """Return the app's expected WSL home from the Windows user name."""
    user_name = os.environ.get("USER") or os.environ.get("USERNAME")
    if not user_name:
        return None
    return f"/home/{user_name.lower()}"


def _build_purge_chat_dir_command(dir_slug: str, expected_home: str | None = None) -> str:
    """Build a guarded shell command that removes a single chat folder.

    The script avoids in-script shell variable assignments (``slug=``,
    ``target=``, ``for base in``). On some Windows + WSL installs, when
    bash is invoked via ``bash -lc <script>`` through a Python subprocess
    argv, local variables silently fail to persist across statements —
    leaving the script running with empty ``$slug`` / ``$target`` and
    the safety ``case`` evaluating an empty string. Inherited env vars
    (``$HOME``) still work, so we use them directly without assignment.

    Defense-in-depth:
      1. Python-side regex on ``dir_slug`` blocks shell metacharacters.
      2. ``expected_home`` is only honoured if it starts with ``/home/``.
      3. The ``$HOME``-based branch is wrapped in a ``case`` guard that
         requires the expanded path to live under ``/home/*/AgentChat/chats/``.
    """
    if not dir_slug or not _SAFE_SLUG_RE.match(dir_slug):
        return ""

    parts: list[str] = []

    if expected_home and expected_home.startswith("/home/"):
        literal_target = f"{expected_home}/AgentChat/chats/{dir_slug}"
        parts.append(f"rm -rf -- {shlex.quote(literal_target)}")

    home_target = f'"$HOME/AgentChat/chats/{dir_slug}"'
    home_pattern = f"/home/*/AgentChat/chats/{dir_slug}"
    parts.append(
        f"case {home_target} in {home_pattern}) rm -rf -- {home_target} ;; esac"
    )

    return "; ".join(parts)


def _purge_windows_chat_dir(dir_slug: str) -> None:
    """Remove the Windows-side chat folder when PowerShell mode created it."""
    if not dir_slug or not _SAFE_SLUG_RE.match(dir_slug):
        logger.warning("Skipping Windows purge: dir_slug %r rejected by safe-slug regex", dir_slug)
        return

    base = (Path.home() / "AgentChat" / "chats").resolve()
    target = (base / dir_slug).resolve()
    if target == base or not target.is_relative_to(base):
        logger.warning("Skipping Windows purge: %s is not under %s", target, base)
        return
    if not target.exists():
        logger.debug("Windows chat dir does not exist, nothing to purge: %s", target)
        return
    logger.info("Purging Windows chat dir: %s", target)
    shutil.rmtree(target)


async def _purge_chat_dir(dir_slug: str) -> None:
    """Remove the chat working folder (Windows + WSL). Best-effort: the DB row
    is already gone, so a stale folder is recoverable but not fatal.

    Defense-in-depth against rm -rf accidents:
       1. Python-side regex: slug must start with ``[a-z0-9]`` and contain only
          ``[a-z0-9_-]``. Rejects "..", "/", empty, absolute paths.
       2. ``expected_home`` substitution is gated on a ``/home/`` prefix.
       3. The ``$HOME`` branch is wrapped in a shell ``case`` guard that
          requires the expansion to live under ``/home/*/AgentChat/chats/<slug>``.
    """
    if not dir_slug or not _SAFE_SLUG_RE.match(dir_slug):
        logger.warning("Purge skipped: dir_slug %r rejected by regex", dir_slug)
        return

    _purge_windows_chat_dir(dir_slug)

    cmd = _build_purge_chat_dir_command(dir_slug, _default_wsl_home())
    if not cmd:
        logger.warning("WSL purge skipped: empty command for dir_slug %r", dir_slug)
        return
    logger.info("WSL purge command for slug %r: %s", dir_slug, cmd)
    try:
        result = await wsl_run(cmd, timeout=120)
        stdout = decode_loose(result.stdout).strip()
        stderr = decode_loose(result.stderr).strip()
        rc = result.returncode
        if rc != 0:
            logger.warning(
                "WSL purge failed for slug %r: exit=%d, stdout=%r, stderr=%r",
                dir_slug, rc, stdout[:200], stderr[:200],
            )
        else:
            logger.info("WSL purge succeeded for slug %r", dir_slug)
            if stdout:
                logger.debug("WSL purge stdout: %s", stdout[:200])
    except FileNotFoundError:
        logger.warning("WSL purge skipped: wsl.exe not found (slug %r)", dir_slug)
    except subprocess.TimeoutExpired:
        logger.warning("WSL purge timed out for slug %r", dir_slug)
    except Exception:
        logger.warning("WSL purge failed for slug %r", dir_slug, exc_info=True)


class ChatSummary(BaseModel):
    """Lightweight chat entry for the sidebar list."""

    id: str
    title: str
    dir_slug: str
    project_id: str = ""
    created_at: int
    updated_at: int


class ChatFull(ChatSummary):
    """A chat with its full message tree included."""

    root: list[Any] = Field(default_factory=list)
    mcp_enabled: list[str] = Field(default_factory=list)


class ChatCreate(BaseModel):
    """Payload for creating a new chat. Server trusts client-supplied id+slug."""

    id: str = Field(min_length=1, max_length=128)
    title: str = ""
    dir_slug: str = ""
    root: list[Any] = Field(default_factory=list)
    created_at: int | None = None
    mcp_enabled: list[str] = Field(default_factory=list)
    project_id: str = ""


class ChatUpdate(BaseModel):
    """Partial update — any subset of mutable fields."""

    title: str | None = None
    dir_slug: str | None = None
    root: list[Any] | None = None
    mcp_enabled: list[str] | None = None
    project_id: str | None = None


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


async def _init_chat_dir_powershell(dir_slug: str) -> None:
    """Initialise the chat directory: npm init -y + python3 -m venv .venv."""
    if not dir_slug or not _SAFE_SLUG_RE.match(dir_slug):
        return
    from main import USER_HOME
    chat_dir = Path(USER_HOME) / "AgentChat" / "chats" / dir_slug
    try:
        chat_dir.mkdir(parents=True, exist_ok=True)
        result = await asyncio.to_thread(
            subprocess.run,
            ["npm", "init", "-y"],
            cwd=str(chat_dir),
            capture_output=True,
            timeout=30,
            creationflags=_NO_WINDOW,
        )
        logger.info(
            "npm init -y (powershell) for %s: exit=%d, stdout=%s",
            dir_slug, result.returncode,
            result.stdout.decode("utf-8", errors="replace").strip()[:200],
        )
    except FileNotFoundError:
        logger.warning("npm not found on Windows for chat %s", dir_slug)
    except Exception:
        logger.warning("npm init -y failed for chat %s", dir_slug, exc_info=True)

    try:
        venv_result = await asyncio.to_thread(
            subprocess.run,
            ["python3", "-m", "venv", str(chat_dir / ".venv")],
            capture_output=True,
            timeout=60,
            creationflags=_NO_WINDOW,
        )
        logger.info(
            "python3 -m venv (powershell) for %s: exit=%d",
            dir_slug, venv_result.returncode,
        )
    except FileNotFoundError:
        logger.warning("python3 not found on Windows for chat %s", dir_slug)
    except Exception:
        logger.warning("python3 -m venv failed for chat %s", dir_slug, exc_info=True)


async def _init_chat_dir_wsl(dir_slug: str) -> None:
    """Initialise the WSL chat directory: npm init -y + python3 -m venv .venv."""
    if not dir_slug or not _SAFE_SLUG_RE.match(dir_slug):
        return
    from main import WSL_USER_HOME
    chat_dir = f"{WSL_USER_HOME}/AgentChat/chats/{dir_slug}"
    cmd = f"mkdir -p {shlex.quote(chat_dir)} && cd {shlex.quote(chat_dir)} && npm init -y && python3 -m venv .venv"
    try:
        result = await wsl_run(cmd, timeout=60)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            logger.warning(
                "npm init -y + venv (wsl) for %s: exit=%d, stderr=%s",
                dir_slug, result.returncode, stderr[:200],
            )
        else:
            stdout = result.stdout.decode("utf-8", errors="replace").strip()
            logger.info(
                "npm init -y + venv (wsl) for %s: exit=0, stdout=%s",
                dir_slug, stdout[:200],
            )
    except FileNotFoundError:
        logger.warning("wsl.exe not found for chat %s", dir_slug)
    except Exception:
        logger.warning("npm init -y + venv (wsl) failed for chat %s", dir_slug, exc_info=True)


@router.post("", response_model=ChatFull)
async def create_chat(request: Request, body: ChatCreate) -> ChatFull:
    store = request.app.state.chat_store
    row = store.upsert_chat(
        chat_id=body.id,
        title=body.title,
        dir_slug=body.dir_slug,
        root=body.root,
        created_at=body.created_at,
        mcp_enabled=body.mcp_enabled,
        project_id=body.project_id,
    )

    # Fire-and-forget: init the chat dir + npm init -y.
    from main import resolve_active_shell
    settings = request.app.state.settings_store
    active_shell = resolve_active_shell(settings.shell_preference)
    if active_shell == "powershell":
        asyncio.ensure_future(_init_chat_dir_powershell(body.dir_slug))
    else:
        asyncio.ensure_future(_init_chat_dir_wsl(body.dir_slug))

    return ChatFull(**row)


@router.put("/{chat_id}", response_model=ChatFull)
async def update_chat(request: Request, chat_id: str, body: ChatUpdate) -> ChatFull:
    row = request.app.state.chat_store.update_chat(
        chat_id=chat_id,
        title=body.title,
        dir_slug=body.dir_slug,
        root=body.root,
        mcp_enabled=body.mcp_enabled,
        project_id=body.project_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    return ChatFull(**row)


@router.delete("/{chat_id}")
async def delete_chat(request: Request, chat_id: str) -> dict[str, str]:
    store = request.app.state.chat_store
    row = store.get_chat(chat_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    dir_slug = row.get("dir_slug") or ""
    logger.info("Deleting chat %s, dir_slug=%r", chat_id, dir_slug)
    if not store.delete_chat(chat_id):
        raise HTTPException(status_code=404, detail=f"Chat '{chat_id}' not found")
    await _purge_chat_dir(dir_slug)
    return {"status": "ok", "dir_slug": dir_slug}
