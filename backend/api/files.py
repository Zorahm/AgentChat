"""GET /api/files — read file content or serve binary files.  POST /api/files/upload — receive user uploads."""
from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

from agent.wsl_exec import wsl_run, wsl_write_bytes

router = APIRouter(prefix="/files", tags=["files"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")

# Office formats we can render by converting to PDF with LibreOffice.
_OFFICE_EXTS = frozenset({"docx", "doc", "pptx", "ppt", "xlsx", "xls", "odt", "odp", "ods", "rtf"})
_PREVIEW_DIR = Path(tempfile.gettempdir()) / "agentchat-preview"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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
    """Serve a binary file (images, PDFs) with auto content-type. Supports WSL paths.

    Disposition is ``inline`` so previews render in an <iframe>/<img>. With the
    default ``attachment`` (which Starlette emits whenever a ``filename`` is set),
    the webview downloads the bytes instead of rendering them — that's why PDFs
    showed a blank pane. Downloads go through a separate client-side blob path,
    so inline here doesn't affect them.
    """
    try:
        media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.startswith("/"):
            data = await _wsl_read_bytes(path)
            suffix = Path(path).suffix
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            tmp.write(data)
            tmp.close()
            return FileResponse(
                tmp.name,
                media_type=media_type,
                filename=Path(path).name,
                content_disposition_type="inline",
            )
        p = Path(path).resolve()
        if not p.exists():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(
            p,
            media_type=media_type,
            filename=p.name,
            content_disposition_type="inline",
        )
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Office preview (LibreOffice → PDF) ─────────────────────────────────


def _find_soffice() -> str | None:
    """Locate LibreOffice's soffice executable for Windows/PowerShell mode."""
    found = shutil.which("soffice") or shutil.which("soffice.com")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")):
        if base:
            candidate = Path(base) / "LibreOffice" / "program" / "soffice.exe"
            if candidate.exists():
                return str(candidate)
    return None


async def _run_local(args: list[str], timeout: int = 120) -> tuple[int, str, str]:
    """Run a local subprocess off the event loop; return (code, stdout, stderr)."""
    try:
        result = await asyncio.to_thread(
            subprocess.run, args, capture_output=True, timeout=timeout, creationflags=_NO_WINDOW,
        )
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", "conversion timed out"
    return (
        result.returncode,
        result.stdout.decode("utf-8", errors="replace"),
        result.stderr.decode("utf-8", errors="replace"),
    )


async def _office_to_pdf_windows(path: str) -> Path:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)
    soffice = _find_soffice()
    if not soffice:
        raise RuntimeError("LibreOffice not found")

    st = p.stat()
    key = hashlib.sha1(f"{p.resolve()}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()
    out_pdf = _PREVIEW_DIR / f"{key}.pdf"
    if out_pdf.exists():
        return out_pdf

    work = _PREVIEW_DIR / key
    work.mkdir(parents=True, exist_ok=True)
    profile = (_PREVIEW_DIR / f"profile-{key}").as_uri()
    code, out, err = await _run_local(
        [soffice, "--headless", f"-env:UserInstallation={profile}",
         "--convert-to", "pdf", "--outdir", str(work), str(p)],
    )
    produced = work / f"{p.stem}.pdf"
    if not produced.exists():
        raise RuntimeError((err or out or "conversion failed").strip())
    produced.replace(out_pdf)
    shutil.rmtree(work, ignore_errors=True)
    return out_pdf


async def _office_to_pdf_wsl(path: str) -> Path:
    stat = await wsl_run(f"stat -c '%Y %s' {shlex.quote(path)}")
    if stat.returncode != 0:
        raise FileNotFoundError(path)
    sig = stat.stdout.decode("utf-8", errors="replace").strip()
    key = hashlib.sha1(f"{path}:{sig}".encode()).hexdigest()
    out_pdf = _PREVIEW_DIR / f"{key}.pdf"
    if out_pdf.exists():
        return out_pdf

    wsl_out = f"/tmp/agentchat-preview/{key}"
    profile = f"/tmp/agentchat-preview/profile-{key}"
    stem = Path(path).stem
    result = await wsl_run(
        f"mkdir -p {shlex.quote(wsl_out)} && "
        f"soffice --headless -env:UserInstallation=file://{profile} "
        f"--convert-to pdf --outdir {shlex.quote(wsl_out)} {shlex.quote(path)}",
        timeout=120,
    )
    produced = f"{wsl_out}/{stem}.pdf"
    try:
        data = await _wsl_read_bytes(produced)
    except FileNotFoundError:
        err = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "LibreOffice conversion failed (is it installed in WSL?)")
    _PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    out_pdf.write_bytes(data)
    return out_pdf


@router.get("/preview")
async def preview_office(
    request: Request,
    path: str = Query(..., description="Absolute path to an Office file"),
) -> FileResponse:
    """Render an Office file (docx/pptx/xlsx/…) by converting it to PDF.

    Uses LibreOffice headless; the PDF is cached by source mtime+size so a
    refresh is instant. 503 when LibreOffice isn't installed — the UI falls back
    to a download hint.
    """
    ext = Path(path).suffix.lower().lstrip(".")
    if ext not in _OFFICE_EXTS:
        raise HTTPException(status_code=400, detail=f"Not a previewable Office file: .{ext}")

    _PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if path.startswith("/"):
            pdf = await _office_to_pdf_wsl(path)
        else:
            pdf = await _office_to_pdf_windows(path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except RuntimeError as exc:
        # Missing LibreOffice or a failed conversion — distinct from "no file".
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return FileResponse(
        pdf,
        media_type="application/pdf",
        filename=f"{Path(path).stem}.pdf",
        content_disposition_type="inline",
    )


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


async def _wsl_upload_dir(chat_dir_slug: str | None) -> str:
    """Resolve where uploads land inside WSL for this request.

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


def _win_upload_dir(chat_dir_slug: str | None, user_home: str) -> Path:
    """Resolve where uploads land on the Windows filesystem (PowerShell mode).

    Mirrors the WSL layout but as a real Windows path under the chat sandbox, so
    the path we hand the model resolves to an actual file when it reads via
    read_file / bash_tool. Without this, PowerShell-mode uploads were written
    through WSL (absent on these machines) and pointed at a non-existent path.
    """
    if chat_dir_slug and _SLUG_RE.match(chat_dir_slug):
        return Path(user_home) / "AgentChat" / "chats" / chat_dir_slug / "uploads"
    day = datetime.now().strftime("%Y-%m-%d")
    return Path(user_home) / ".aicache" / "uploads" / day


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
    request: Request,
    files: list[UploadFile],
    chat_dir_slug: str | None = Form(default=None),
) -> list[dict[str, object]]:
    # Match the upload location to the shell the agent will actually use. WSL →
    # write into WSL; PowerShell fallback → write to the Windows filesystem.
    # (Previously WSL-only: in PowerShell mode the file was never written to
    # Windows and the model got a Unix path that resolved to nothing.)
    from paths import USER_HOME
    from shell import resolve_active_shell

    preference = getattr(request.app.state.settings_store, "shell_preference", "auto")
    shell = resolve_active_shell(preference)

    if shell == "powershell":
        win_dir = _win_upload_dir(chat_dir_slug, USER_HOME)
        await asyncio.to_thread(win_dir.mkdir, parents=True, exist_ok=True)
        dir_path = str(win_dir)
    else:
        dir_path = await _wsl_upload_dir(chat_dir_slug)

    results: list[dict[str, object]] = []

    for f in files:
        data = await f.read()
        name = _safe_filename(f.filename or "unnamed")

        if shell == "powershell":
            full = str(Path(dir_path) / name)
            await asyncio.to_thread(Path(full).write_bytes, data)
        else:
            full = f"{dir_path}/{name}"
            await wsl_write_bytes(full, data)

        result: dict[str, object] = {
            "name": name,
            "path": full,
            "size": len(data),
            "mime_type": f.content_type or "application/octet-stream",
        }

        # PDF text extraction relies on WSL pdftotext; skip it in PowerShell mode
        # (the model can still open the file at the returned Windows path).
        if name.lower().endswith(".pdf") and shell != "powershell":
            text = await _extract_pdf_text(full)
            if text:
                result["content"] = text

        results.append(result)

    return results


@router.post("/delete")
async def delete_upload(
    request: Request,
    path: str = Form(...),
    chat_dir_slug: str | None = Form(default=None),
) -> dict[str, object]:
    """Delete a previously uploaded file from the chat's uploads folder.

    The on-disk target is recomputed from ``chat_dir_slug`` + the basename, so a
    caller can only ever delete a file *inside* the resolved uploads directory —
    the client path is trusted for its filename only, never as an absolute
    target (no traversal, no escaping the sandbox). Missing files are a no-op.
    """
    from paths import USER_HOME
    from shell import resolve_active_shell

    name = _safe_filename(Path(path).name)
    if name in ("", ".", "..") or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid filename")

    preference = getattr(request.app.state.settings_store, "shell_preference", "auto")
    shell = resolve_active_shell(preference)

    if shell == "powershell":
        target = _win_upload_dir(chat_dir_slug, USER_HOME) / name
        await asyncio.to_thread(lambda: target.unlink(missing_ok=True))
    else:
        up_dir = await _wsl_upload_dir(chat_dir_slug)
        await wsl_run(f"rm -f {shlex.quote(f'{up_dir}/{name}')}")

    return {"deleted": True, "name": name}
