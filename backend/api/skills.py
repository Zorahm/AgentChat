"""Skills REST API — Skills 2.0 standard."""

from __future__ import annotations

import io
import re
import shlex
import shutil
import tarfile
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile

from agent.wsl_exec import wsl_read_bytes, wsl_read_text, wsl_run
from api.schemas.skills import (
    CatalogInstallRequest,
    InstallLocalRequest,
    InstallRequest,
    SkillContent,
    SkillFile,
    SkillInfo,
    SkillLocation,
)
from paths import resolve_bundled_skills
from skills.catalog import CURATED_BY_KEY
from skills.reader import SkillEntry, _parse_frontmatter

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


@router.post("/install-catalog", response_model=list[SkillInfo])
async def install_catalog_skill(request: Request, body: CatalogInstallRequest) -> list[SkillInfo]:
    """Install one curated Anthropic skill (docx/xlsx/pptx/pdf/frontend-design)."""
    installer = request.app.state.skill_installer
    curated = CURATED_BY_KEY.get(body.key)
    if curated is None:
        raise HTTPException(status_code=400, detail=f"Unknown catalog skill '{body.key}'")
    # Bundled skills (the office four) install offline from the local copy;
    # fall back to GitHub if the bundle is missing or the skill isn't bundled.
    bundled_root = resolve_bundled_skills()
    try:
        if curated.local_subdir and bundled_root is not None:
            source_dir = bundled_root / curated.local_subdir
            if source_dir.is_dir():
                entries = installer.install_local(source_dir, curated.key)
            else:
                entries = installer.install_subdir(curated.repo, curated.subdir, curated.key)
        else:
            entries = installer.install_subdir(curated.repo, curated.subdir, curated.key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return [_to_skill_info(e) for e in entries]


def _slugify_skill_name(raw: str) -> str:
    """Turn a frontmatter name into a safe install folder slug."""
    s = re.sub(r"[^a-z0-9_\-]+", "-", raw.strip().lower()).strip("-")
    return s[:64]


async def _materialize_wsl_skill_dir(root: str) -> Path:
    """Copy a skill folder out of WSL into a local temp dir via a single tar pipe.

    The model writes skills inside the WSL chat sandbox ('/home/.../AgentChat/
    chats/...'), which Python on Windows can't read directly — so we stream the
    folder as a tar and extract it locally, then hand that to install_local.
    """
    res = await wsl_run(f"cd {shlex.quote(root)} && tar -cf - .")
    if res.returncode != 0:
        err = res.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(err or "Could not read the skill folder from WSL")

    tmp = Path(tempfile.mkdtemp(prefix="agentchat-skill-"))
    try:
        with tarfile.open(fileobj=io.BytesIO(res.stdout), mode="r:") as tf:
            members = tf.getmembers()
            if len(members) > 2000:
                raise ValueError("Skill folder has too many files")
            for m in members:
                name = m.name.replace("\\", "/").lstrip("./")
                if name.startswith("/") or ".." in Path(name).parts:
                    raise ValueError(f"Unsafe path in skill folder: {m.name}")
            tf.extractall(tmp)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return tmp


@router.post("/install-local", response_model=list[SkillInfo])
async def install_local_skill(request: Request, body: InstallLocalRequest) -> list[SkillInfo]:
    """Install a skill the model authored in a chat sandbox.

    Accepts either a SKILL.md (the whole containing folder is copied) or a
    .skill / .zip archive (unpacked). Only paths inside a chat sandbox
    ('/AgentChat/chats/') are accepted.
    """
    installer = request.app.state.skill_installer
    raw_path = body.path.strip()
    norm = raw_path.replace("\\", "/")
    base = Path(norm).name
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""

    if "/AgentChat/chats/" not in norm:
        raise HTTPException(
            status_code=400,
            detail="Only a skill created inside a chat can be installed from here",
        )

    is_wsl = raw_path.startswith("/")

    # ── .skill / .zip archive → unpack it ──────────────────────────────
    if ext in ("skill", "zip"):
        try:
            data = await wsl_read_bytes(raw_path) if is_wsl else Path(raw_path).read_bytes()
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Archive not found")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        try:
            entries = installer.install_from_archive(data, base)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        return [_to_skill_info(e) for e in entries]

    # ── SKILL.md → copy the containing folder ──────────────────────────
    if base.lower() != "skill.md":
        raise HTTPException(
            status_code=400, detail="Path must point to a SKILL.md or a .skill/.zip archive"
        )

    try:
        md_text = await wsl_read_text(raw_path) if is_wsl else Path(raw_path).read_text(
            "utf-8", errors="replace"
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="SKILL.md not found")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    meta, _ = _parse_frontmatter(md_text)
    parent = norm.rsplit("/", 1)[0]
    name = _slugify_skill_name(meta.get("name", "") or parent.rsplit("/", 1)[-1])
    if not name:
        raise HTTPException(status_code=400, detail="Could not determine a valid skill name")

    tmp: Path | None = None
    try:
        if is_wsl:
            tmp = await _materialize_wsl_skill_dir(parent)
            source_dir = tmp
        else:
            source_dir = Path(raw_path).parent
        entries = installer.install_local(source_dir, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)

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
