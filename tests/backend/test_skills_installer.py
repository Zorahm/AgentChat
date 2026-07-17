"""Tests for GitHubSkillInstaller.install_local — offline install of a bundled skill."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from skills.installer import MARKER_NAME, GitHubSkillInstaller
from skills.reader import AgentSkillsReader


def _make_bundled_skill(root: Path, name: str) -> Path:
    """Create a minimal bundled skill folder with a SKILL.md and a script."""
    src = root / name
    (src / "scripts").mkdir(parents=True)
    (src / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test {name}\n---\n\n# {name}\n", encoding="utf-8"
    )
    (src / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")
    (src / "__pycache__").mkdir()
    (src / "__pycache__" / "junk.pyc").write_text("x", encoding="utf-8")
    return src


@pytest.fixture
def installer(tmp_path: Path) -> tuple[GitHubSkillInstaller, AgentSkillsReader, Path]:
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    reader = AgentSkillsReader(skills_dir)
    return GitHubSkillInstaller(skills_dir, reader), reader, skills_dir


class TestInstallLocal:
    def test_copies_skill_and_marks_it(self, installer, tmp_path: Path) -> None:
        inst, reader, skills_dir = installer
        src = _make_bundled_skill(tmp_path / "bundle", "docx")

        entries = inst.install_local(src, "docx")

        assert [e.name for e in entries] == ["docx"]
        dest = skills_dir / "docx"
        assert (dest / "SKILL.md").is_file()
        assert (dest / "scripts" / "run.py").is_file()
        # Marker stamped so uninstall is allowed.
        assert (dest / MARKER_NAME).is_file()
        # Noise dirs are not copied.
        assert not (dest / "__pycache__").exists()
        # Reader sees it.
        assert reader.get("docx") is not None

    def test_reinstall_overwrites_our_install(self, installer, tmp_path: Path) -> None:
        inst, _reader, skills_dir = installer
        src = _make_bundled_skill(tmp_path / "bundle", "pdf")
        inst.install_local(src, "pdf")
        # Second install of the same skill should succeed (it carries our marker).
        entries = inst.install_local(src, "pdf")
        assert [e.name for e in entries] == ["pdf"]

    def test_refuses_to_clobber_foreign_dir(self, installer, tmp_path: Path) -> None:
        inst, _reader, skills_dir = installer
        # A skill placed by someone else (no marker).
        foreign = skills_dir / "pptx"
        foreign.mkdir()
        (foreign / "SKILL.md").write_text("---\nname: pptx\n---\n", encoding="utf-8")
        src = _make_bundled_skill(tmp_path / "bundle", "pptx")

        with pytest.raises(ValueError, match="wasn't installed by AgentChat"):
            inst.install_local(src, "pptx")

    def test_missing_source_raises(self, installer, tmp_path: Path) -> None:
        inst, _reader, _skills_dir = installer
        with pytest.raises(ValueError, match="not found"):
            inst.install_local(tmp_path / "does-not-exist", "docx")

    def test_rejects_unsafe_name(self, installer, tmp_path: Path) -> None:
        inst, _reader, _skills_dir = installer
        src = _make_bundled_skill(tmp_path / "bundle", "docx")
        with pytest.raises(ValueError, match="Unsafe skill name"):
            inst.install_local(src, "../evil")


def _client(inst, reader):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.skills import router

    app = FastAPI()
    app.state.skill_installer = inst
    app.state.skill_reader = reader
    app.include_router(router)
    return TestClient(app)


class TestInstallLocalEndpoint:
    """POST /skills/install-local — installs a SKILL.md the model wrote in a chat."""

    def test_installs_from_chat_sandbox_and_slugifies_name(self, installer, tmp_path: Path) -> None:
        inst, reader, skills_dir = installer
        skill = tmp_path / "AgentChat" / "chats" / "chat-x" / "myskill"
        (skill / "scripts").mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: My Skill\ndescription: d\n---\n# x\n", encoding="utf-8"
        )
        (skill / "scripts" / "run.py").write_text("print(1)\n", encoding="utf-8")

        r = _client(inst, reader).post(
            "/skills/install-local", json={"path": str(skill / "SKILL.md")}
        )
        assert r.status_code == 200, r.text
        # Skill NAME comes from frontmatter; the install FOLDER is the slug.
        assert [s["name"] for s in r.json()] == ["My Skill"]
        assert (skills_dir / "my-skill" / "SKILL.md").is_file()
        assert (skills_dir / "my-skill" / "scripts" / "run.py").is_file()

    def test_rejects_path_outside_chat_sandbox(self, installer, tmp_path: Path) -> None:
        inst, reader, _skills_dir = installer
        loose = tmp_path / "somewhere" / "myskill"
        loose.mkdir(parents=True)
        (loose / "SKILL.md").write_text("---\nname: x\n---\n", encoding="utf-8")

        r = _client(inst, reader).post(
            "/skills/install-local", json={"path": str(loose / "SKILL.md")}
        )
        assert r.status_code == 400

    def test_installs_skill_archive_from_chat_sandbox(self, installer, tmp_path: Path) -> None:
        import io
        import zipfile

        inst, reader, skills_dir = installer
        chat_dir = tmp_path / "AgentChat" / "chats" / "chat-x"
        chat_dir.mkdir(parents=True)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("packed/SKILL.md", "---\nname: Packed\n---\n# p\n")
            zf.writestr("packed/scripts/run.py", "print(1)\n")
        archive = chat_dir / "myskill.skill"
        archive.write_bytes(buf.getvalue())

        r = _client(inst, reader).post(
            "/skills/install-local", json={"path": str(archive)}
        )
        assert r.status_code == 200, r.text
        # Install folder = archive stem; SKILL.md is found at any depth.
        assert (skills_dir / "myskill" / "packed" / "SKILL.md").is_file()
        assert reader.get("Packed") is not None

    def test_rejects_non_skill_md_path(self, installer, tmp_path: Path) -> None:
        inst, reader, _skills_dir = installer
        f = tmp_path / "AgentChat" / "chats" / "chat-x" / "notes.md"
        f.parent.mkdir(parents=True)
        f.write_text("hi", encoding="utf-8")

        r = _client(inst, reader).post("/skills/install-local", json={"path": str(f)})
        assert r.status_code == 400
