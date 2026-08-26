"""Agent Plugins §6/§7.1 — component discovery.

The rule worth a test of its own: discovery inside a plugin stops at the
immediate children of ``skills/``. Our own skills reader walks a whole tree,
so getting this wrong would look like it works and quietly pull in every
nested SKILL.md a plugin happens to ship as documentation.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from plugins.skill_discovery import discover_skills


def _skill(root: Path, rel: str, *, name: str | None = None, description: str = "does a thing") -> Path:
    directory = root / rel
    directory.mkdir(parents=True, exist_ok=True)
    frontmatter = ["---"]
    if name is not None:
        frontmatter.append(f"name: {name}")
    if description:
        frontmatter.append(f"description: {description}")
    frontmatter += ["---", "", "# body", ""]
    (directory / "SKILL.md").write_text("\n".join(frontmatter), encoding="utf-8")
    return directory


def test_absent_skills_directory_is_not_an_error(tmp_path: Path) -> None:
    result = discover_skills(tmp_path)
    assert result.skills == ()
    assert result.issues == ()


def test_skills_path_that_is_a_file_invalidates_the_component(tmp_path: Path) -> None:
    (tmp_path / "skills").write_text("not a directory", encoding="utf-8")
    result = discover_skills(tmp_path)
    assert result.skills == ()
    assert [i.level for i in result.issues] == ["error"]


def test_immediate_children_are_discovered(tmp_path: Path) -> None:
    _skill(tmp_path, "skills/deploy", name="deploy")
    _skill(tmp_path, "skills/summarize", name="summarize")
    result = discover_skills(tmp_path)
    assert sorted(s.name for s in result.skills) == ["deploy", "summarize"]


def test_discovery_does_not_recurse(tmp_path: Path) -> None:
    """A SKILL.md deeper than one level is not a second skill."""
    _skill(tmp_path, "skills/deploy", name="deploy")
    _skill(tmp_path, "skills/deploy/references/nested", name="nested")
    _skill(tmp_path, "skills/group/inner", name="inner")
    result = discover_skills(tmp_path)
    assert [s.name for s in result.skills] == ["deploy"]


def test_directory_without_skill_md_is_quietly_skipped(tmp_path: Path) -> None:
    (tmp_path / "skills" / "assets").mkdir(parents=True)
    result = discover_skills(tmp_path)
    assert result.skills == ()
    assert result.issues == ()


def test_missing_frontmatter_skips_only_that_skill(tmp_path: Path) -> None:
    _skill(tmp_path, "skills/good", name="good")
    _skill(tmp_path, "skills/nameless", name=None)
    _skill(tmp_path, "skills/mute", name="mute", description="")
    result = discover_skills(tmp_path)
    assert [s.name for s in result.skills] == ["good"]
    assert {i.target for i in result.issues if i.level == "error"} == {"nameless", "mute"}


def test_name_mismatch_is_a_warning_not_a_skip(tmp_path: Path) -> None:
    _skill(tmp_path, "skills/deploy", name="ship-it")
    result = discover_skills(tmp_path)
    assert [s.name for s in result.skills] == ["ship-it"]
    assert [i.level for i in result.issues] == ["warning"]


def test_metadata_is_carried_through(tmp_path: Path) -> None:
    directory = tmp_path / "skills" / "deploy"
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        "---\nname: deploy\ndescription: ships it\nversion: 2.1\nauthor: Ada\n---\n",
        encoding="utf-8",
    )
    entry = discover_skills(tmp_path).skills[0]
    assert (entry.version, entry.author, entry.path) == ("2.1", "Ada", directory)
