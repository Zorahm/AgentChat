"""Skills REST API — Skills 2.0 standard."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile

from api.schemas.skills import InstallRequest, SkillContent, SkillFile, SkillInfo, SkillLocation
from skills.reader import SkillEntry

router = APIRouter(prefix="/skills", tags=["skills"])

_SKIP_DIRS = frozenset({".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"})
_MAX_TREE_ENTRIES = 400  # cap to keep the side panel cheap
_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024  # 50 MB cap on uploaded .skill / .zip


def _to_skill_info(skill: SkillEntry) -> SkillInfo:
    return SkillInfo(
        name=skill.name,
        description=skill.description,
        version=skill.version,
        author=skill.author,
        path=str(skill.path),
    )


@router.get("", response_model=list[SkillInfo])
async def list_skills(request: Request) -> list[SkillInfo]:
    reader = request.app.state.skill_reader
    reader.rebuild()
    return [_to_skill_info(s) for s in reader.list_skills()]


@router.get("/location", response_model=SkillLocation)
async def skills_location(request: Request) -> SkillLocation:
    reader = request.app.state.skill_reader
    return SkillLocation(skills_dir=str(reader.skills_dir))


@router.post("/install", response_model=list[SkillInfo])
async def install_skill(request: Request, body: InstallRequest) -> list[SkillInfo]:
    installer = request.app.state.skill_installer
    try:
        entries = installer.install(body.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return [_to_skill_info(e) for e in entries]


@router.post("/install-file", response_model=list[SkillInfo])
async def install_skill_file(request: Request, file: UploadFile) -> list[SkillInfo]:
    """Install a skill from a locally uploaded .skill / .zip archive."""
    installer = request.app.state.skill_installer
    data = await file.read(_MAX_ARCHIVE_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > _MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MB")
    name = file.filename or "skill.zip"
    if not name.lower().endswith((".skill", ".zip")):
        raise HTTPException(status_code=400, detail="Expected a .skill or .zip archive")
    try:
        entries = installer.install_from_archive(data, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return [_to_skill_info(e) for e in entries]


@router.delete("/{name}")
async def uninstall_skill(request: Request, name: str) -> dict[str, str]:
    reader = request.app.state.skill_reader
    installer = request.app.state.skill_installer
    reader.rebuild()
    entry = reader.get(name)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")

    # Only allow removing skills that carry our ``.agentchat-installed`` marker
    # — either on the skill dir itself or on a parent (collection root). Skills
    # planted in ~/.agents/skills/ by the user or by other agent systems
    # (Claude Code, etc.) have no marker and stay untouched.
    if not installer.is_installed_by_us(entry.path):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Skill '{name}' was not installed by AgentChat and cannot be "
                f"removed from here. Delete its folder manually if you really "
                f"want it gone."
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
