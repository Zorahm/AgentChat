"""What the model is told about installed plugins.

Before this, a plugin's skill arrived in the index indistinguishable from one
the user had installed by hand: the model could use it but could not say where
it came from, could not find the README beside it, and had no idea the concept
existed. These pin the three halves of the fix — the origin on the skill line,
the roster, and the section that explains what a plugin is.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent.prompt.context import RuntimeFacts
from agent.system_prompt import build_system_prompt
from plugins.registry import PluginRegistry
from skills.reader import AgentSkillsReader
from test_plugins_registry import make_plugin  # shared package builder


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    plugins_dir = tmp_path / "plugins"
    data_dir = tmp_path / "plugin-data"
    plugins_dir.mkdir()
    return plugins_dir, data_dir


# ── the skill line carries its origin ────────────────────────────────────


def test_a_plugin_skill_names_its_plugin_in_the_index(
    dirs: tuple[Path, Path], tmp_path: Path
) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "acme.tools", skills={"deploy": "deploy"})
    installed = tmp_path / "skills" / "own"
    installed.mkdir(parents=True)
    (installed / "SKILL.md").write_text(
        "---\nname: own\ndescription: installed by hand\n---\n", encoding="utf-8"
    )

    reader = AgentSkillsReader(installed.parent)
    PluginRegistry(plugins_dir, data_dir).apply_to_reader(reader)
    reader.rebuild()

    rendered = reader.render_prompt()
    assert "**deploy**" in rendered
    assert "acme.tools" in rendered, "a plugin skill must name the package it came in"
    # A hand-installed skill has no plugin, and must not grow a fake one.
    own_line = next(line for line in rendered.splitlines() if "**own**" in line)
    assert "plugin" not in own_line


def test_skill_origin_survives_a_rebuild(dirs: tuple[Path, Path], tmp_path: Path) -> None:
    """The reader clears its cache on every rebuild; the origin is not lost with it."""
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "acme.tools", skills={"deploy": "deploy"})
    reader = AgentSkillsReader(tmp_path / "empty")
    PluginRegistry(plugins_dir, data_dir).apply_to_reader(reader)

    reader.rebuild()
    reader.rebuild(force=True)
    entry = reader.get("deploy")
    assert entry is not None and entry.plugin == "acme.tools"


# ── the roster ───────────────────────────────────────────────────────────


def test_roster_lists_components_and_the_package_directory(
    dirs: tuple[Path, Path]
) -> None:
    plugins_dir, data_dir = dirs
    root = make_plugin(
        plugins_dir,
        "acme.tools",
        manifest={
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": "acme.tools",
            "version": "1.4.0",
            "description": "Ships things.",
        },
        skills={"deploy": "deploy"},
        servers={"validator": {"type": "stdio", "command": "npx"}},
    )
    rendered = PluginRegistry(plugins_dir, data_dir).render_prompt()

    assert "Installed plugins" in rendered
    assert "**acme.tools**" in rendered
    assert "v1.4.0" in rendered and "Ships things." in rendered
    assert "`deploy`" in rendered
    assert "`validator` (stdio)" in rendered
    assert str(root) in rendered, "the package directory is the fact only this can supply"


def test_no_plugins_renders_nothing(dirs: tuple[Path, Path]) -> None:
    assert PluginRegistry(*dirs).render_prompt() == ""


def test_a_disabled_plugin_is_not_advertised(dirs: tuple[Path, Path]) -> None:
    """Listing it would invite the model to reach for a skill it does not have."""
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "acme.tools", skills={"deploy": "deploy"})
    registry = PluginRegistry(plugins_dir, data_dir)
    registry.set_disabled({"acme.tools"})
    assert registry.render_prompt() == ""


def test_an_invalid_plugin_is_not_advertised(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(
        plugins_dir,
        "broken",
        manifest={
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": "Not Valid",
        },
    )
    assert PluginRegistry(plugins_dir, data_dir).render_prompt() == ""


# ── the section that explains the concept ────────────────────────────────


def test_the_plugins_section_is_absent_without_plugins() -> None:
    prompt = build_system_prompt(user_name="Zorahm")
    assert "## Plugins" not in prompt


def test_the_plugins_section_appears_with_a_roster() -> None:
    prompt = build_system_prompt(
        user_name="Zorahm",
        has_plugins=True,
        runtime=RuntimeFacts(plugins_block="### Installed plugins\n\n- **acme.tools**"),
    )
    assert "## Plugins" in prompt
    assert "agent-plugins.org" in prompt
    # The two failure modes the prose exists to prevent.
    assert "read_skill" in prompt, "must say a plugin skill is read like any other"
    assert "Settings" in prompt, "must say installing is the user's job, not the model's"


def test_the_section_follows_the_skills_contract() -> None:
    """Provenance only makes sense after skills have been introduced."""
    prompt = build_system_prompt(user_name="Zorahm", has_skills=True, has_plugins=True)
    assert prompt.index("## Skills") < prompt.index("## Plugins")


def test_the_roster_reaches_the_prompt_through_the_plugins_variable() -> None:
    from agent.prompt import variables

    assert variables.is_known("plugins")
    assert "plugins" not in variables.VOLATILE_NAMES, (
        "the roster is session-stable; marking it volatile would split every "
        "persona that mentions it out of the cached prefix"
    )
