"""Bundled skills: the office rule they teach, and keeping them up to date.

Two things are pinned here:

* office/binary formats are refused by write_file/edit_file, while the Python
  script that generates them stays an ordinary text write;
* an installed bundled skill follows the app — a new version's SKILL.md reaches
  users who installed the old one, without trampling a folder they have edited.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy  # noqa: E402
from shell import resolve_active_shell  # noqa: E402
from skills.bundled_sync import sync_bundled_skills  # noqa: E402
from skills.fingerprint import fingerprint  # noqa: E402
from skills.installer import GitHubSkillInstaller, MARKER_NAME, read_marker  # noqa: E402
from skills.reader import AgentSkillsReader  # noqa: E402
from tools.binary_formats import BINARY_DOC_EXTENSIONS  # noqa: E402
from tools.edit_file import EditFileTool  # noqa: E402
from tools.write_file import WriteFileTool  # noqa: E402

HOST_SHELL = resolve_active_shell("powershell")


# ── the office rule ──────────────────────────────────────────────────────


def _write_tool(chat_dir: Path) -> WriteFileTool:
    tool = WriteFileTool()
    tool.set_policy(SandboxPolicy(chat_dir=str(chat_dir), shell=HOST_SHELL))
    return tool


class TestOfficeFormatsAreRefused:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", ["report.docx", "data.xlsx", "deck.pptx", "out.pdf"])
    async def test_write_file_refuses_and_names_the_library(
        self, tmp_path: Path, name: str
    ) -> None:
        out = await _write_tool(tmp_path).execute(path=name, content="PK\x03\x04 nope")

        assert out.startswith("Error:")
        assert "bash_tool" in out  # tells the model where to go instead
        assert not (tmp_path / name).exists()  # nothing corrupt left on disk

    @pytest.mark.asyncio
    async def test_the_refusal_names_the_generator_for_that_format(self, tmp_path: Path) -> None:
        assert "python-docx" in await _write_tool(tmp_path).execute(path="a.docx", content="x")
        assert "openpyxl" in await _write_tool(tmp_path).execute(path="a.xlsx", content="x")
        assert "python-pptx" in await _write_tool(tmp_path).execute(path="a.pptx", content="x")
        assert "reportlab" in await _write_tool(tmp_path).execute(path="a.pdf", content="x")

    @pytest.mark.asyncio
    async def test_edit_file_refuses_them_too(self, tmp_path: Path) -> None:
        tool = EditFileTool()
        tool.set_policy(SandboxPolicy(chat_dir=str(tmp_path), shell=HOST_SHELL))

        out = await tool.execute(path=str(tmp_path / "a.docx"), old_string="a", new_string="b")

        assert out.startswith("Error:")
        assert "python-docx" in out

    @pytest.mark.asyncio
    async def test_the_generator_script_is_still_an_ordinary_write(self, tmp_path: Path) -> None:
        """The whole point: .py is text, so writing the script that emits the
        document must keep working — only the document itself is refused."""
        script = "from docx import Document\nDocument().save('report.docx')\n"

        out = await _write_tool(tmp_path).execute(path="build_report.py", content=script)

        assert out.startswith("Created")
        assert (tmp_path / "build_report.py").read_text(encoding="utf-8") == script

    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", ["notes.md", "data.csv", "page.html", "raw.txt"])
    async def test_text_formats_are_untouched(self, tmp_path: Path, name: str) -> None:
        out = await _write_tool(tmp_path).execute(path=name, content="hello")
        assert out.startswith("Created")

    def test_no_text_format_slipped_into_the_refusal_list(self) -> None:
        assert BINARY_DOC_EXTENSIONS.isdisjoint({".py", ".csv", ".md", ".txt", ".html", ".rtf"})


# ── keeping installed copies current ─────────────────────────────────────


@pytest.fixture
def bundle(tmp_path: Path) -> Path:
    """A stand-in for the app's bundled skills root, holding one office skill."""
    root = tmp_path / "bundled"
    (root / "docx").mkdir(parents=True)
    (root / "docx" / "SKILL.md").write_text(
        '---\nname: docx\ndescription: "d"\nversion: "1.0.0"\n---\n\nold body\n',
        encoding="utf-8",
    )
    return root


@pytest.fixture
def installer(tmp_path: Path) -> GitHubSkillInstaller:
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    return GitHubSkillInstaller(skills_dir, AgentSkillsReader(skills_dir))


def _bump(bundle: Path, body: str) -> None:
    (bundle / "docx" / "SKILL.md").write_text(
        f'---\nname: docx\ndescription: "d"\nversion: "1.1.0"\n---\n\n{body}\n',
        encoding="utf-8",
    )


def test_a_new_app_version_reaches_an_already_installed_skill(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    installer.install_local(bundle / "docx", "docx")
    _bump(bundle, "NEW body: generate with code")

    result = sync_bundled_skills(installer, bundle)

    assert result.updated == ("docx",)
    installed = (installer.skills_dir / "docx" / "SKILL.md").read_text(encoding="utf-8")
    assert "NEW body: generate with code" in installed
    assert 'version: "1.1.0"' in installed


def test_an_unchanged_bundle_is_left_alone(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    installer.install_local(bundle / "docx", "docx")

    assert sync_bundled_skills(installer, bundle) == sync_bundled_skills(installer, bundle)
    assert sync_bundled_skills(installer, bundle).updated == ()


def test_a_skill_the_user_edited_is_never_overwritten(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    installer.install_local(bundle / "docx", "docx")
    mine = installer.skills_dir / "docx" / "SKILL.md"
    mine.write_text("my own notes\n", encoding="utf-8")
    _bump(bundle, "upstream rewrite")

    result = sync_bundled_skills(installer, bundle)

    assert result.skipped_modified == ("docx",)
    assert mine.read_text(encoding="utf-8") == "my own notes\n"


def test_a_skill_the_user_never_installed_is_not_installed_behind_their_back(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    (bundle / "pptx").mkdir()
    (bundle / "pptx" / "SKILL.md").write_text(
        '---\nname: pptx\ndescription: "d"\nversion: "1.0.0"\n---\n\nbody\n', encoding="utf-8"
    )
    installer.install_local(bundle / "docx", "docx")

    sync_bundled_skills(installer, bundle)

    assert not (installer.skills_dir / "pptx").exists()


def test_a_folder_we_did_not_install_is_left_alone(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    """The skills dir is shared with Claude Code et al. — no marker, no touching."""
    theirs = installer.skills_dir / "docx"
    theirs.mkdir()
    (theirs / "SKILL.md").write_text("someone else's docx skill\n", encoding="utf-8")

    result = sync_bundled_skills(installer, bundle)

    assert result.updated == ()
    assert (theirs / "SKILL.md").read_text(encoding="utf-8") == "someone else's docx skill\n"


def test_a_legacy_marker_without_a_fingerprint_still_gets_refreshed(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    """Installs predating this feature carry no baseline — they are exactly the
    stale copies the sync exists to fix, so they refresh."""
    installer.install_local(bundle / "docx", "docx")
    marker = installer.skills_dir / "docx" / MARKER_NAME
    marker.write_text("installed-by=agentchat\nsource=bundled:docx\n", encoding="utf-8")
    _bump(bundle, "fresh body")

    result = sync_bundled_skills(installer, bundle)

    assert result.updated == ("docx",)
    assert "fresh body" in (installer.skills_dir / "docx" / "SKILL.md").read_text(encoding="utf-8")


def test_a_missing_bundle_is_a_no_op(installer: GitHubSkillInstaller) -> None:
    assert sync_bundled_skills(installer, None).updated == ()


def test_the_marker_records_version_and_fingerprint(
    installer: GitHubSkillInstaller, bundle: Path
) -> None:
    installer.install_local(bundle / "docx", "docx")

    marker = read_marker(installer.skills_dir / "docx")

    assert marker["source"] == "bundled:docx"
    assert marker["version"]
    assert marker["content"] == fingerprint(bundle / "docx")


def test_the_fingerprint_follows_content_and_layout(tmp_path: Path) -> None:
    a, b = tmp_path / "a", tmp_path / "b"
    for root in (a, b):
        (root / "scripts").mkdir(parents=True)
        (root / "SKILL.md").write_text("same\n", encoding="utf-8")
        (root / "scripts" / "run.py").write_text("print(1)\n", encoding="utf-8")
    assert fingerprint(a) == fingerprint(b)

    # A renamed file is a change, even with identical bytes everywhere.
    (b / "scripts" / "run.py").rename(b / "scripts" / "main.py")
    assert fingerprint(a) != fingerprint(b)


def test_build_noise_never_moves_the_fingerprint(tmp_path: Path) -> None:
    """__pycache__/.pyc are dropped by the installer's copy — hashing them would
    make every fresh install look like a user edit."""
    root = tmp_path / "s"
    (root / "scripts").mkdir(parents=True)
    (root / "SKILL.md").write_text("body\n", encoding="utf-8")
    before = fingerprint(root)

    (root / "scripts" / "__pycache__").mkdir()
    (root / "scripts" / "__pycache__" / "x.cpython-312.pyc").write_bytes(b"\x00\x01")
    (root / MARKER_NAME).write_text("installed-by=agentchat\n", encoding="utf-8")

    assert fingerprint(root) == before
