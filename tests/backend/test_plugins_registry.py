"""The plugin registry — composition and failure isolation (§11.3).

What these pin: a plugin is a *virtual source*. Its skills and MCP servers are
derived on load and never copied anywhere, an enabled/disabled plugin is still
listed either way, and one broken package costs only itself.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from plugins.registry import PluginRegistry
from schemas.plugins import MCP_SCHEMA_1_0_0, PLUGIN_SCHEMA_1_0_0
from skills.reader import AgentSkillsReader


def make_plugin(
    plugins_dir: Path,
    name: str,
    *,
    manifest: dict | None = None,
    skills: dict[str, str] | None = None,
    servers: dict | None = None,
) -> Path:
    """Write a plugin package. *skills* maps a directory name to a skill name."""
    root = plugins_dir / name
    root.mkdir(parents=True, exist_ok=True)
    document = manifest if manifest is not None else {"$schema": PLUGIN_SCHEMA_1_0_0, "name": name}
    (root / "plugin.json").write_text(json.dumps(document), encoding="utf-8")
    for directory, skill_name in (skills or {}).items():
        skill_dir = root / "skills" / directory
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {skill_name}\ndescription: from {name}\n---\n", encoding="utf-8"
        )
    if servers is not None:
        (root / "mcp.json").write_text(
            json.dumps({"$schema": MCP_SCHEMA_1_0_0, "mcpServers": servers}), encoding="utf-8"
        )
    return root


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    plugins_dir = tmp_path / "plugins"
    data_dir = tmp_path / "plugin-data"
    plugins_dir.mkdir()
    return plugins_dir, data_dir


def test_a_valid_plugin_contributes_its_components(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(
        plugins_dir,
        "demo",
        skills={"deploy": "deploy"},
        servers={"validator": {"type": "stdio", "command": "npx"}},
    )
    registry = PluginRegistry(plugins_dir, data_dir)

    plugin = registry.get("demo")
    assert plugin is not None and plugin.valid and plugin.active
    assert [s.name for s in registry.skill_entries()] == ["deploy"]
    assert [s.name for s in registry.mcp_servers()] == ["demo: validator"]


def test_plugin_data_is_created_for_a_launchable_server(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "demo", servers={"a": {"type": "stdio", "command": "npx"}})
    PluginRegistry(plugins_dir, data_dir).list_plugins()
    assert (data_dir / "demo").is_dir()


def test_plugin_data_is_not_created_for_a_disabled_plugin(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "demo", servers={"a": {"type": "stdio", "command": "npx"}})
    registry = PluginRegistry(plugins_dir, data_dir)
    registry.set_disabled({"demo"})
    registry.list_plugins()
    assert not (data_dir / "demo").exists()


def test_a_disabled_plugin_is_listed_but_contributes_nothing(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(
        plugins_dir,
        "demo",
        skills={"deploy": "deploy"},
        servers={"a": {"type": "stdio", "command": "npx"}},
    )
    registry = PluginRegistry(plugins_dir, data_dir)
    registry.set_disabled({"demo"})

    plugin = registry.get("demo")
    assert plugin is not None and plugin.valid and not plugin.active
    assert plugin.skills, "the card still shows what the plugin holds"
    assert registry.skill_entries() == []
    assert registry.mcp_servers() == []


def test_a_rejected_manifest_yields_no_components(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(
        plugins_dir,
        "broken",
        manifest={"$schema": PLUGIN_SCHEMA_1_0_0, "name": "Not A Valid Name"},
        skills={"deploy": "deploy"},
    )
    registry = PluginRegistry(plugins_dir, data_dir)

    plugin = registry.get("broken")
    assert plugin is not None and not plugin.valid
    assert plugin.skills == ()
    assert any(i.level == "error" for i in plugin.issues)


def test_one_broken_plugin_does_not_hide_a_good_one(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "good", skills={"deploy": "deploy"})
    (plugins_dir / "bad").mkdir()
    (plugins_dir / "bad" / "plugin.json").write_text("{ nope", encoding="utf-8")

    registry = PluginRegistry(plugins_dir, data_dir)
    assert [p.name for p in registry.list_plugins()] == ["bad", "good"]
    assert [s.name for s in registry.skill_entries()] == ["deploy"]


def test_directories_that_are_not_packages_are_ignored(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    (plugins_dir / "notes").mkdir()
    (plugins_dir / ".staging-abc").mkdir()
    (plugins_dir / ".staging-abc" / "plugin.json").write_text(
        json.dumps({"$schema": PLUGIN_SCHEMA_1_0_0, "name": "half-built"}), encoding="utf-8"
    )
    assert PluginRegistry(plugins_dir, data_dir).list_plugins() == []


def test_manifest_name_differing_from_the_directory_is_a_warning(
    dirs: tuple[Path, Path]
) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(
        plugins_dir, "folder", manifest={"$schema": PLUGIN_SCHEMA_1_0_0, "name": "declared"}
    )
    plugin = PluginRegistry(plugins_dir, data_dir).get("folder")
    assert plugin is not None and plugin.valid
    assert [i.level for i in plugin.issues] == ["warning"]


def test_owns_server_identifies_the_contributing_plugin(dirs: tuple[Path, Path]) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "demo", servers={"a": {"type": "stdio", "command": "npx"}})
    registry = PluginRegistry(plugins_dir, data_dir)
    server_id = registry.mcp_servers()[0].id
    assert registry.owns_server(server_id) == "demo"
    assert registry.owns_server("something-else") is None


# ── merging into the shared skills index ─────────────────────────────────


def test_plugin_skills_reach_the_reader(dirs: tuple[Path, Path], tmp_path: Path) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "demo", skills={"deploy": "deploy"})
    installed = tmp_path / "skills"
    installed.mkdir()

    reader = AgentSkillsReader(installed)
    PluginRegistry(plugins_dir, data_dir).apply_to_reader(reader)
    reader.rebuild()
    assert reader.list_names() == ["deploy"]


def test_an_installed_skill_shadows_a_plugin_of_the_same_name(
    dirs: tuple[Path, Path], tmp_path: Path
) -> None:
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "demo", skills={"deploy": "deploy"})
    installed = tmp_path / "skills" / "deploy"
    installed.mkdir(parents=True)
    (installed / "SKILL.md").write_text(
        "---\nname: deploy\ndescription: the user's own\n---\n", encoding="utf-8"
    )

    reader = AgentSkillsReader(installed.parent)
    PluginRegistry(plugins_dir, data_dir).apply_to_reader(reader)
    reader.rebuild()
    entry = reader.get("deploy")
    assert entry is not None and entry.description == "the user's own"


def test_toggling_a_plugin_is_visible_through_the_readers_cache(
    dirs: tuple[Path, Path], tmp_path: Path
) -> None:
    """Enabling a plugin touches no scanned directory, so the cache must be told."""
    plugins_dir, data_dir = dirs
    make_plugin(plugins_dir, "demo", skills={"deploy": "deploy"})
    installed = tmp_path / "skills"
    installed.mkdir()
    registry = PluginRegistry(plugins_dir, data_dir)
    reader = AgentSkillsReader(installed)

    registry.apply_to_reader(reader)
    reader.rebuild()
    assert reader.list_names() == ["deploy"]

    registry.set_disabled({"demo"})
    registry.apply_to_reader(reader)
    reader.rebuild()
    assert reader.list_names() == []
