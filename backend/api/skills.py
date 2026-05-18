"""Skills REST API — Skills 2.0 standard."""

from __future__ import annotations

import shutil

from fastapi import APIRouter, HTTPException, Request

from api.models import InstallRequest, SkillContent, SkillInfo

router = APIRouter(prefix="/skills", tags=["skills"])


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
