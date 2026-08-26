"""Installing and removing plugin packages.

The invariants worth guarding: a package lands under the name its *manifest*
declares (not the folder or zip it arrived in), a package we would refuse to
load is refused at install time instead, and nothing this app did not install
is ever deleted — ``~/.agents`` is a shared tree.
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from plugins.installer import PluginInstaller
from plugins.registry import PluginRegistry
from schemas.plugins import PLUGIN_SCHEMA_1_0_0
from skills.install_marker import MARKER_NAME, read_marker


def _manifest(name: str) -> str:
    return json.dumps({"$schema": PLUGIN_SCHEMA_1_0_0, "name": name, "version": "1.2.3"})


def _source_package(root: Path, folder: str, declared: str) -> Path:
    package = root / folder
    (package / "skills" / "deploy").mkdir(parents=True)
    (package / "plugin.json").write_text(_manifest(declared), encoding="utf-8")
    (package / "skills" / "deploy" / "SKILL.md").write_text(
        "---\nname: deploy\ndescription: ships it\n---\n", encoding="utf-8"
    )
    (package / "__pycache__").mkdir()
    (package / "__pycache__" / "junk.pyc").write_text("x", encoding="utf-8")
    return package


def _zip_of(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buffer.getvalue()


@pytest.fixture
def installer(tmp_path: Path) -> PluginInstaller:
    plugins_dir = tmp_path / "plugins"
    data_dir = tmp_path / "plugin-data"
    plugins_dir.mkdir()
    registry = PluginRegistry(plugins_dir, data_dir)
    return PluginInstaller(plugins_dir, data_dir, registry)


# ── local directory ──────────────────────────────────────────────────────


def test_install_local_uses_the_declared_name(installer: PluginInstaller, tmp_path: Path) -> None:
    source = _source_package(tmp_path / "src", "some-folder", "acme.tools")
    plugin = installer.install_local(source)

    assert plugin.name == "acme.tools"
    assert (installer.plugins_dir / "acme.tools" / "plugin.json").is_file()
    assert not (installer.plugins_dir / "some-folder").exists()
    assert [s.name for s in plugin.skills] == ["deploy"]


def test_install_local_writes_a_marker_and_drops_build_noise(
    installer: PluginInstaller, tmp_path: Path
) -> None:
    source = _source_package(tmp_path / "src", "pkg", "demo")
    installer.install_local(source)
    dest = installer.plugins_dir / "demo"

    assert (dest / MARKER_NAME).is_file()
    assert read_marker(dest)["source"].startswith("local:")
    assert not (dest / "__pycache__").exists()
    assert installer.is_installed_by_us("demo")


def test_install_local_rejects_a_directory_without_a_manifest(
    installer: PluginInstaller, tmp_path: Path
) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="plugin.json"):
        installer.install_local(empty)


def test_a_package_we_would_refuse_to_load_is_refused_at_install(
    installer: PluginInstaller, tmp_path: Path
) -> None:
    source = _source_package(tmp_path / "src", "pkg", "Not Valid")
    with pytest.raises(ValueError, match="Invalid plugin.json"):
        installer.install_local(source)
    assert list(installer.plugins_dir.iterdir()) == []


def test_reinstalling_replaces_our_own_copy(installer: PluginInstaller, tmp_path: Path) -> None:
    source = _source_package(tmp_path / "src", "pkg", "demo")
    installer.install_local(source)
    (installer.plugins_dir / "demo" / "stale.txt").write_text("old", encoding="utf-8")

    installer.install_local(source)
    assert not (installer.plugins_dir / "demo" / "stale.txt").exists()


def test_a_directory_we_did_not_install_is_never_clobbered(
    installer: PluginInstaller, tmp_path: Path
) -> None:
    squatter = installer.plugins_dir / "demo"
    squatter.mkdir()
    (squatter / "precious.txt").write_text("mine", encoding="utf-8")
    source = _source_package(tmp_path / "src", "pkg", "demo")

    with pytest.raises(ValueError, match="wasn't installed by AgentChat"):
        installer.install_local(source)
    assert (squatter / "precious.txt").read_text(encoding="utf-8") == "mine"


# ── archives ─────────────────────────────────────────────────────────────


def test_install_from_archive(installer: PluginInstaller) -> None:
    data = _zip_of(
        {
            "plugin.json": _manifest("zipped"),
            "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: ships it\n---\n",
        }
    )
    plugin = installer.install_from_archive(data, "whatever.zip")
    assert plugin.name == "zipped"
    assert [s.name for s in plugin.skills] == ["deploy"]


def test_install_from_archive_unwraps_a_single_top_level_folder(
    installer: PluginInstaller,
) -> None:
    data = _zip_of({"my-plugin-main/plugin.json": _manifest("wrapped")})
    assert installer.install_from_archive(data, "x.zip").name == "wrapped"


def test_archive_paths_that_escape_are_rejected(installer: PluginInstaller) -> None:
    data = _zip_of({"plugin.json": _manifest("evil"), "../escape.txt": "pwned"})
    with pytest.raises(ValueError, match="Unsafe path"):
        installer.install_from_archive(data, "evil.zip")
    assert not (installer.plugins_dir.parent / "escape.txt").exists()


def test_a_zip_without_a_manifest_is_refused(installer: PluginInstaller) -> None:
    with pytest.raises(ValueError, match="not an Agent Plugin"):
        installer.install_from_archive(_zip_of({"readme.md": "hi"}), "x.zip")


def test_a_corrupt_archive_is_refused(installer: PluginInstaller) -> None:
    with pytest.raises(ValueError, match="valid zip"):
        installer.install_from_archive(b"definitely not a zip", "x.zip")


# ── github ───────────────────────────────────────────────────────────────


def test_install_from_github(installer: PluginInstaller, monkeypatch: pytest.MonkeyPatch) -> None:
    data = _zip_of(
        {
            "repo-main/plugin.json": _manifest("from-github"),
            "repo-main/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: d\n---\n",
        }
    )
    monkeypatch.setattr(installer, "_fetch", lambda url: data)
    plugin = installer.install_from_github("owner/repo")

    assert plugin.name == "from-github"
    assert read_marker(installer.plugins_dir / "from-github")["source"] == "owner/repo"


def test_install_from_a_github_subdirectory(
    installer: PluginInstaller, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = _zip_of(
        {
            "repo-main/README.md": "ignore me",
            "repo-main/packages/tool/plugin.json": _manifest("nested"),
        }
    )
    monkeypatch.setattr(installer, "_fetch", lambda url: data)
    plugin = installer.install_from_github("owner/repo/packages/tool")

    assert plugin.name == "nested"
    assert not (installer.plugins_dir / "nested" / "README.md").exists()


def test_a_missing_subdirectory_is_reported(
    installer: PluginInstaller, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(installer, "_fetch", lambda url: _zip_of({"repo-main/x.txt": "hi"}))
    with pytest.raises(ValueError, match="nothing under"):
        installer.install_from_github("owner/repo/does/not/exist")


@pytest.mark.parametrize("source", ["owner", "", "/"])
def test_a_malformed_github_source_is_rejected(installer: PluginInstaller, source: str) -> None:
    with pytest.raises(ValueError, match="owner/repo"):
        installer.install_from_github(source)


# ── uninstall ────────────────────────────────────────────────────────────


def test_uninstall_removes_the_package_and_its_data(
    installer: PluginInstaller, tmp_path: Path
) -> None:
    source = _source_package(tmp_path / "src", "pkg", "demo")
    installer.install_local(source)
    data = installer.data_dir / "demo"
    data.mkdir(parents=True, exist_ok=True)
    (data / "state.db").write_text("x", encoding="utf-8")

    installer.uninstall("demo")
    assert not (installer.plugins_dir / "demo").exists()
    assert not data.exists()


def test_uninstall_refuses_a_directory_we_did_not_install(installer: PluginInstaller) -> None:
    squatter = installer.plugins_dir / "theirs"
    squatter.mkdir()
    (squatter / "plugin.json").write_text(_manifest("theirs"), encoding="utf-8")

    with pytest.raises(ValueError, match="not installed by AgentChat"):
        installer.uninstall("theirs")
    assert squatter.exists()


def test_uninstalling_something_absent_is_an_error(installer: PluginInstaller) -> None:
    with pytest.raises(ValueError, match="No plugin named"):
        installer.uninstall("ghost")
