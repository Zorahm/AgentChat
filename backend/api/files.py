"""GET /api/files — read file content or serve binary files.  POST /api/files/upload — receive user uploads."""
from __future__ import annotations

import os
import re
import shlex
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

from agent.wsl_exec import wsl_run, wsl_write_bytes

router = APIRouter(prefix="/files", tags=["files"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")


async def _wsl_read_bytes(path: str) -> bytes:
    """Read a file from WSL via wsl.exe. Raises FileNotFoundError / OSError on failure."""
    result = await wsl_run(f"cat {shlex.quote(path)}")
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace").strip()
        if "No such file" in err or "not found" in err.lower():
            raise FileNotFoundError(err)
        raise OSError(err or f"wsl read failed with code {result.returncode}")
    return result.stdout


@router.get("/content")
async def read_content(
    path: str = Query(..., description="Absolute file path"),
) -> PlainTextResponse:
    """Return UTF-8 text content of a file. Supports WSL paths starting with '/'."""
    try:
        if path.startswith("/"):
            data = await _wsl_read_bytes(path)
            return PlainTextResponse(data.decode("utf-8", errors="replace"))
        p = Path(path).resolve()
        content = p.read_text(encoding="utf-8", errors="replace")
        return PlainTextResponse(content)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/serve")
async def serve_file(
    path: str = Query(..., description="Absolute file path"),
) -> FileResponse:
    """Serve a binary file (images, PDFs) with auto content-type. Supports WSL paths."""
    try:
        if path.startswith("/"):
            data = await _wsl_read_bytes(path)
            suffix = Path(path).suffix
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            tmp.write(data)
            tmp.close()
            return FileResponse(tmp.name, filename=Path(path).name)
        p = Path(path).resolve()
        if not p.exists():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(p)
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Upload ────────────────────────────────────────────────────────────

_cached_wsl_home: str | None = None


async def _wsl_home() -> str:
    """Resolve the real WSL home directory via echo $HOME."""
    global _cached_wsl_home
    if _cached_wsl_home is not None:
        return _cached_wsl_home
    try:
        result = await wsl_run("echo $HOME")
        home = result.stdout.decode("utf-8", errors="replace").strip()
        if home and result.returncode == 0:
            _cached_wsl_home = home
            return home
    except Exception:
        pass
    _cached_wsl_home = "/tmp"
    return _cached_wsl_home


async def _upload_dir(chat_dir_slug: str | None) -> str:
    """Resolve where uploads land for this request.

    Per-chat folder when a valid slug is provided — keeps uploads inside the
    sandbox so the model can read them. Falls back to the legacy date-bucketed
    cache directory if no slug is supplied (rare; pre-sandbox clients).
    """
    home = await _wsl_home()
    if chat_dir_slug and _SLUG_RE.match(chat_dir_slug):
        return f"{home}/AgentChat/chats/{chat_dir_slug}/uploads"
    base = f"{home}/.aicache/uploads" if home != "/tmp" else "/tmp/aicache-uploads"
    day = datetime.now().strftime("%Y-%m-%d")
    return f"{base}/{day}"


def _safe_filename(name: str) -> str:
    """Strip path components and dangerous chars from a user-supplied filename."""
    bare = Path(name).name or "unnamed"
    # Drop anything that would break a shell-quoted path or escape the dir.
    cleaned = re.sub(r"[^\w\s._\-()]+", "_", bare, flags=re.UNICODE)
    return cleaned[:200] or "unnamed"


async def _extract_pdf_text(wsl_path: str) -> str | None:
    """Try to extract text from a PDF via WSL pdftotext. Returns None on failure."""
    try:
        result = await wsl_run(f"pdftotext {shlex.quote(wsl_path)} - 2>/dev/null")
        if result.returncode == 0 and result.stdout:
            text = result.stdout.decode("utf-8", errors="replace").strip()
            return text[:50000] if len(text) > 50000 else text
    except Exception:
        pass
    return None


@router.post("/upload")
async def upload_files(
    files: list[UploadFile],
    chat_dir_slug: str | None = Form(default=None),
) -> list[dict[str, object]]:
    dir_path = await _upload_dir(chat_dir_slug)
    results: list[dict[str, object]] = []

    for f in files:
        data = await f.read()
        name = _safe_filename(f.filename or "unnamed")
        full = f"{dir_path}/{name}"
        await wsl_write_bytes(full, data)

        result: dict[str, object] = {
            "name": name,
            "path": full,
            "size": len(data),
            "mime_type": f.content_type or "application/octet-stream",
        }

        if name.lower().endswith(".pdf"):
            text = await _extract_pdf_text(full)
            if text:
                result["content"] = text

        results.append(result)

    return results
