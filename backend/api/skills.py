"""Skills REST API — Skills 2.0 standard."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile

from api.schemas.skills import InstallRequest, SkillContent, SkillFile, SkillInfo

router = APIRouter(prefix="/skills", tags=["skills"])

_SKIP_DIRS = frozenset({".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"})
_MAX_TREE_ENTRIES = 400  # cap to keep the side panel cheap
_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024  # 50 MB cap on uploaded .skill / .zip


@router.get("", response_model=list[SkillInfo])
async def list_skills(request: Request) -> list[SkillInfo]:
    reader = request.app.state.skill_reader
    reader.rebuild()
    return [
        SkillInfo(name=s.name, description=s.description, version=s.version, author=s.author)
        for s in reader.list_skills()
    ]


@router.post("/install", response_model=list[SkillInfo])
async def install_skill(request: Request, body: InstallRequest) -> list[SkillInfo]:
    installer = request.app.state.skill_installer
    try:
        entries = installer.install(body.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return [
        SkillInfo(name=e.name, description=e.description, version=e.version, author=e.author)
        for e in entries
    ]


@router.post("/install-file", response_model=list[SkillInfo])
async def install_skill_file(request: Request, file: UploadFile) -> list[SkillInfo]:
    """Install a skill from a locally uploaded .skill / .zip archive."""
    installer = request.app.state.skill_installer
    data = await file.read(_MAX_ARCHIVE_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Пустой файл")
    if len(data) > _MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="Файл больше 50 МБ")
    name = file.filename or "skill.zip"
    if not name.lower().endswith((".skill", ".zip")):
        raise HTTPException(status_code=400, detail="Ожидается .skill или .zip архив")
    try:
        entries = installer.install_from_archive(data, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return [
        SkillInfo(name=e.name, description=e.description, version=e.version, author=e.author)
        for e in entries
    ]


@router.delete("/{name}")
async def uninstall_skill(request: Request, name: str) -> dict[str, str]:
    reader = request.app.state.skill_reader
    installer = request.app.state.skill_installer
    reader.rebuild()
    entry = reader.get(name)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")

    # Only allow removing skills inside the app's own install dir. Skills
    # discovered in the shared ~/.agents/skills/ tree are managed by the user
    # (or another agent system) and must not be silently deleted.
    install_root = installer.skills_dir.resolve()
    try:
        entry.path.resolve().relative_to(install_root)
    except ValueError:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Skill '{name}' lives outside this app's install dir "
                f"({install_root}) and cannot be removed from here."
            ),
        )

    shutil.rmtree(entry.path, ignore_errors=True)
    reader.rebuild()
    return {"status": "uninstalled", "name": name}


@router.get("/{name}/read", response_model=SkillContent)
async def read_skill_content(request: Request, name: str) -> SkillContent:
    reader = request.app.state.skill_reader
    path = reader.find_skill_md(name)
    if path is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    try:
        content = path.read_text("utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return SkillContent(name=name, content=content)


@router.get("/{name}/files", response_model=list[SkillFile])
async def list_skill_files(request: Request, name: str) -> list[SkillFile]:
    """Flat directory listing of a skill, depth-first, sorted dirs-first then name."""
    reader = request.app.state.skill_reader
    reader.rebuild()
    entry = reader.get(name)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")

    root = entry.path
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill directory missing for '{name}'")

    out: list[SkillFile] = []

    def walk(d: Path, depth: int) -> None:
        if len(out) >= _MAX_TREE_ENTRIES:
            return
        try:
            children = list(d.iterdir())
        except OSError:
            return
        # Dirs first, then files, both alphabetical — matches the reference design.
        children.sort(key=lambda c: (not c.is_dir(), c.name.lower()))
        for c in children:
            if c.name.startswith(".") or c.name in _SKIP_DIRS:
                continue
            rel = c.relative_to(root).as_posix()
            if c.is_dir():
                try:
                    child_count = sum(1 for _ in c.iterdir())
                except OSError:
                    child_count = 0
                out.append(SkillFile(
                    path=rel, name=c.name, depth=depth, is_dir=True, size=child_count,
                ))
                walk(c, depth + 1)
            else:
                try:
                    size = c.stat().st_size
                except OSError:
                    size = 0
                out.append(SkillFile(
                    path=rel, name=c.name, depth=depth, is_dir=False, size=size,
                ))
            if len(out) >= _MAX_TREE_ENTRIES:
                return

    # Synthetic root entry so the design's `pptx/` header line appears.
    out.append(SkillFile(path="", name=root.name, depth=0, is_dir=True, size=0))
    walk(root, 1)
    return out
