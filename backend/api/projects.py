"""CRUD for projects — a custom prompt plus a set of files whose text is
extracted once at upload and injected into every chat in the project.

Raw file bytes live under ~/AgentChat/projects/{project_id}/files/ so the
model can still open a file directly when extraction failed (the chat path
whitelists this directory for reads). Extracted text is cached in SQLite.
"""

from __future__ import annotations

import logging
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from extraction import extract_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


def _projects_root() -> Path:
    """Base directory for all project file storage (native filesystem)."""
    return Path.home() / "AgentChat" / "projects"


def _files_dir(project_id: str) -> Path:
    return _projects_root() / project_id / "files"


def _safe_filename(name: str) -> str:
    """Strip path components and dangerous chars from a user-supplied filename."""
    bare = Path(name).name or "unnamed"
    cleaned = re.sub(r"[^\w\s._\-()]+", "_", bare, flags=re.UNICODE)
    return cleaned[:200] or "unnamed"


# ── schemas ─────────────────────────────────────────────────────────────


class ProjectSummary(BaseModel):
    id: str
    name: str
    instructions: str
    file_count: int = 0
    created_at: int
    updated_at: int


class ProjectFileInfo(BaseModel):
    id: str
    project_id: str
    name: str
    size: int
    mime_type: str
    extract_status: str
    text_len: int = 0
    created_at: int


class ProjectFull(BaseModel):
    id: str
    name: str
    instructions: str
    created_at: int
    updated_at: int
    files: list[ProjectFileInfo] = Field(default_factory=list)


class ProjectFileText(BaseModel):
    id: str
    name: str
    mime_type: str
    extract_status: str
    text: str


class ProjectCreate(BaseModel):
    name: str = Field(default="Новый проект", max_length=200)
    instructions: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    instructions: str | None = None


# ── routes ──────────────────────────────────────────────────────────────


@router.get("", response_model=list[ProjectSummary])
async def list_projects(request: Request) -> list[ProjectSummary]:
    rows = request.app.state.project_store.list_projects()
    return [ProjectSummary(**r) for r in rows]


@router.post("", response_model=ProjectFull)
async def create_project(request: Request, body: ProjectCreate) -> ProjectFull:
    store = request.app.state.project_store
    project_id = uuid.uuid4().hex
    row = store.create_project(project_id, body.name, body.instructions)
    return ProjectFull(**row)


@router.get("/{project_id}", response_model=ProjectFull)
async def get_project(request: Request, project_id: str) -> ProjectFull:
    row = request.app.state.project_store.get_project(project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    return ProjectFull(**row)


@router.put("/{project_id}", response_model=ProjectFull)
async def update_project(request: Request, project_id: str, body: ProjectUpdate) -> ProjectFull:
    row = request.app.state.project_store.update_project(
        project_id, name=body.name, instructions=body.instructions
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    return ProjectFull(**row)


@router.delete("/{project_id}")
async def delete_project(request: Request, project_id: str) -> dict[str, str]:
    store = request.app.state.project_store
    if not store.delete_project(project_id):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    # Chats of this project survive as standalone chats (don't orphan them with
    # a dangling project_id).
    request.app.state.chat_store.clear_project(project_id)
    # Best-effort: drop the on-disk files folder. DB rows are already gone via
    # the FK cascade, so a stray folder is recoverable, not fatal.
    target = (_projects_root() / project_id).resolve()
    if target.is_relative_to(_projects_root().resolve()) and target.exists():
        try:
            shutil.rmtree(target)
        except OSError:
            logger.warning("Failed to remove project dir %s", target, exc_info=True)
    return {"status": "ok"}


@router.post("/{project_id}/files", response_model=list[ProjectFileInfo])
async def upload_project_files(
    request: Request,
    project_id: str,
    files: list[UploadFile],
) -> list[ProjectFileInfo]:
    store = request.app.state.project_store
    if store.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")

    dest_dir = _files_dir(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    results: list[ProjectFileInfo] = []

    for f in files:
        data = await f.read()
        name = _safe_filename(f.filename or "unnamed")
        disk_path = dest_dir / name
        disk_path.write_bytes(data)

        text, status = extract_text(data, name, f.content_type or "")
        meta = store.add_file(
            file_id=uuid.uuid4().hex,
            project_id=project_id,
            name=name,
            size=len(data),
            mime_type=f.content_type or "application/octet-stream",
            disk_path=str(disk_path),
            extracted_text=text,
            extract_status=status,
        )
        results.append(ProjectFileInfo(**meta))

    return results


@router.get("/{project_id}/files/{file_id}/text", response_model=ProjectFileText)
async def get_project_file_text(
    request: Request, project_id: str, file_id: str
) -> ProjectFileText:
    store = request.app.state.project_store
    row = store.get_file_text(file_id)
    if row is None or row["project_id"] != project_id:
        raise HTTPException(status_code=404, detail=f"File '{file_id}' not found")
    return ProjectFileText(
        id=row["id"],
        name=row["name"],
        mime_type=row["mime_type"],
        extract_status=row["extract_status"],
        text=row["extracted_text"],
    )


@router.delete("/{project_id}/files/{file_id}")
async def delete_project_file(request: Request, project_id: str, file_id: str) -> dict[str, str]:
    store = request.app.state.project_store
    disk_path = store.delete_file(file_id)
    if disk_path is None:
        raise HTTPException(status_code=404, detail=f"File '{file_id}' not found")
    try:
        p = Path(disk_path)
        if p.exists():
            p.unlink()
    except OSError:
        logger.warning("Failed to unlink project file %s", disk_path, exc_info=True)
    return {"status": "ok"}
