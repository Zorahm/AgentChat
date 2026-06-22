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
