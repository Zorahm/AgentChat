from __future__ import annotations

from pydantic import BaseModel, Field


class SkillInfo(BaseModel):
    name: str
    description: str = ""
    version: str = ""
    author: str = ""
    path: str = ""


class SkillLocation(BaseModel):
    skills_dir: str


class InstallRequest(BaseModel):
    source: str = Field(description="Skill name in the registry (e.g. 'docx')")


class CatalogInstallRequest(BaseModel):
    key: str = Field(description="Curated catalog key (e.g. 'docx', 'frontend-design')")


class InstallLocalRequest(BaseModel):
    path: str = Field(
        description="Absolute path to a SKILL.md inside a chat sandbox "
        "(WSL '/home/.../AgentChat/chats/...' or a Windows path)."
    )


class SkillContent(BaseModel):
    name: str
    content: str


class SkillFile(BaseModel):
    path: str
    name: str
    depth: int
    is_dir: bool
    size: int = 0


class ErrorResponse(BaseModel):
    detail: str
