"""Installing and removing Agent Plugins.

Agent Plugins deliberately says nothing about where plugins come from —
sources, registries and marketplaces are the client's business. What the spec
*does* fix is the package: a directory whose ``plugin.json`` names it. So every
install here follows the same shape — materialise the package somewhere
staging, read its manifest, and only then claim a directory named after it.

A plugin that would be rejected on load is rejected at install time instead,
with the manifest's own error. Putting a package on disk that the loader will
refuse to run is a worse outcome than a failed install.
"""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError

from archive_fetch import GITHUB_BRANCHES, extract_zip, fetch, github_zip_url
from plugins.manifest import load_manifest
from plugins.registry import LoadedPlugin, PluginRegistry
from schemas.plugins import MANIFEST_FILE_NAME, PluginManifest
from skills.install_marker import has_marker_above, write_marker

_STAGING_PREFIX = ".staging-"


@dataclass(frozen=True)
class _Staged:
    """A materialised package plus the manifest that names it."""

    root: Path
    manifest: PluginManifest


class PluginInstaller:
    """Puts plugin packages into ``plugins_dir`` and takes them out again."""

    # Build noise a copy should never carry into the install.
    _COPY_IGNORE = ("__pycache__", "*.pyc", ".git", ".DS_Store", "node_modules")

    def __init__(self, plugins_dir: Path, data_dir: Path, registry: PluginRegistry) -> None:
        self.plugins_dir = plugins_dir
        self.data_dir = data_dir
        self._registry = registry

    # ── install ──────────────────────────────────────────────────────────

    def install_from_github(self, source: str) -> LoadedPlugin:
        """Install from ``owner/repo`` or ``owner/repo/path/to/plugin``."""
        parts = [p for p in source.strip().strip("/").split("/") if p]
        if len(parts) < 2:
            raise ValueError(f"Expected 'owner/repo', got {source!r}")
        owner, repo = parts[0], parts[1]
        subdir = "/".join(parts[2:])

        staging = self._new_staging()
        try:
            self._download_into(owner, repo, subdir, staging, label=source)
            staged = self._stage(staging)
            return self._place(staged, source=source)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def install_local(self, source_dir: Path) -> LoadedPlugin:
        """Install by copying a package that already sits on this machine."""
        if not source_dir.is_dir():
            raise ValueError(f"No directory at {source_dir}")
        if not (source_dir / MANIFEST_FILE_NAME).is_file():
            raise ValueError(f"{source_dir} has no {MANIFEST_FILE_NAME}")

        staging = self._new_staging()
        try:
            shutil.copytree(
                source_dir,
                staging,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns(*self._COPY_IGNORE),
            )
            staged = self._stage(staging)
            return self._place(staged, source=f"local:{source_dir}")
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def install_from_archive(self, data: bytes, filename: str) -> LoadedPlugin:
        """Install from an uploaded ``.zip``."""
        staging = self._new_staging()
        try:
            try:
                extract_zip(data, staging)
            except zipfile.BadZipFile as exc:
                raise ValueError(f"Not a valid zip archive: {exc}") from exc
            staged = self._stage(staging)
            return self._place(staged, source=filename)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    # ── removal ──────────────────────────────────────────────────────────

    def is_installed_by_us(self, name: str) -> bool:
        return has_marker_above(self.plugins_dir / name, self.plugins_dir)

    def uninstall(self, name: str) -> None:
        """Remove a plugin and the data directory kept for it.

        Refuses a directory this app did not install: ``~/.agents`` is shared,
        and a plugin dropped there by hand (or by another client) is not ours
        to delete.
        """
        root = self.plugins_dir / name
        if not root.is_dir():
            raise ValueError(f"No plugin named {name!r}")
        if not self.is_installed_by_us(name):
            raise ValueError(
                f"{name!r} was not installed by AgentChat — remove {root} by hand "
                "if you really want it gone"
            )
        shutil.rmtree(root, ignore_errors=True)
        # §9.1 allows deleting PLUGIN_DATA on uninstall, and leaving it would
        # silently resurrect old state if the plugin were reinstalled later.
        shutil.rmtree(self.data_dir / name, ignore_errors=True)
        self._registry.invalidate()
        self._registry.rebuild(force=True)

    # ── internals ────────────────────────────────────────────────────────

    def _new_staging(self) -> Path:
        """A scratch directory beside the installs, so the final move is local.

        Dot-prefixed: the registry skips those, so a half-built package is
        never seen as an installed plugin.
        """
        self.plugins_dir.mkdir(parents=True, exist_ok=True)
        return Path(tempfile.mkdtemp(dir=self.plugins_dir, prefix=_STAGING_PREFIX))

    def _download_into(
        self, owner: str, repo: str, subdir: str, staging: Path, *, label: str
    ) -> None:
        last_error: Exception | None = None
        for branch in GITHUB_BRANCHES:
            prefix = f"{repo}-{branch}/" + (f"{subdir}/" if subdir else "")
            try:
                data = self._fetch(github_zip_url(owner, repo, branch))
            except HTTPError as exc:
                last_error = exc
                if exc.code == 404:
                    continue
                raise ValueError(f"Cannot download {label!r}: HTTP {exc.code}") from exc
            except URLError as exc:
                raise ValueError(f"Network error for {label!r}: {exc.reason}") from exc
            if extract_zip(data, staging, prefix) == 0:
                raise ValueError(f"{label!r} has nothing under {subdir!r}")
            return
        raise ValueError(f"Repository {label!r} not found on GitHub") from last_error

    def _stage(self, staging: Path) -> _Staged:
        """Locate the package root under *staging* and validate its manifest."""
        root = _find_package_root(staging)
        if root is None:
            raise ValueError(f"No {MANIFEST_FILE_NAME} found — not an Agent Plugin")
        result = load_manifest(root)
        if result.manifest is None:
            reasons = "; ".join(i.message for i in result.issues if i.level == "error")
            raise ValueError(f"Invalid {MANIFEST_FILE_NAME}: {reasons or 'unknown error'}")
        return _Staged(root=root, manifest=result.manifest)

    def _place(self, staged: _Staged, *, source: str) -> LoadedPlugin:
        """Move a validated package to its final name and register it."""
        name = staged.manifest.name
        dest = self.plugins_dir / name
        if dest.exists() and not has_marker_above(dest, self.plugins_dir):
            raise ValueError(
                f"{name!r} already exists at {dest} and wasn't installed by AgentChat. "
                "Remove it by hand if you really want to replace it."
            )
        if dest.exists():
            shutil.rmtree(dest)
        shutil.move(str(staged.root), str(dest))
        write_marker(dest, source=source)

        self._registry.invalidate()
        self._registry.rebuild(force=True)
        installed = self._registry.get(name)
        if installed is None:  # pragma: no cover — the manifest just validated
            raise RuntimeError(f"Installed {name!r} to {dest} but it did not load")
        return installed

    # Seam the test suite substitutes to install without touching the network.
    def _fetch(self, url: str) -> bytes:
        return fetch(url)


def _find_package_root(staging: Path) -> Path | None:
    """Return the directory holding ``plugin.json``.

    Checks the staging root, then its single child — an uploaded zip usually
    wraps the package in one folder, while a GitHub archive has already had
    that wrapper stripped by the extraction prefix.
    """
    if (staging / MANIFEST_FILE_NAME).is_file():
        return staging
    try:
        children = [p for p in staging.iterdir() if p.is_dir()]
    except OSError:
        return None
    if len(children) == 1 and (children[0] / MANIFEST_FILE_NAME).is_file():
        return children[0]
    return None
