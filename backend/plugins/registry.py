"""The installed-plugin registry — the one place a plugin becomes components.

Plugins are a *virtual source*: nothing is copied into ``~/.agents/skills/``
and nothing is written into ``settings.json``. The registry loads each package
in place and hands out the skills and MCP server configs derived from it, so
uninstalling is exactly "delete the directory and rebuild".

Failure isolation (§11.3) is the shape of this module: one plugin's rejected
manifest, one skill's missing frontmatter and one server's bad transport each
cost only themselves. Every refusal is kept as an issue rather than dropped.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from plugins.manifest import load_manifest
from plugins.mcp_config import PluginMCPServer, load_mcp_config
from plugins.skill_discovery import discover_skills
from schemas.mcp import MCPServerConfig
from schemas.plugins import (
    MANIFEST_FILE_NAME,
    SCHEMA_VERSIONS,
    PluginIssue,
    PluginManifest,
)
from skills.reader import AgentSkillsReader, SkillEntry

logger = logging.getLogger(__name__)

_PROMPT_TEMPLATE = "### Installed plugins\n\n{plugins}"


@dataclass(frozen=True)
class LoadedPlugin:
    """One installed plugin, as far as this process could load it."""

    name: str  # the directory name — the identity used in URLs and settings
    root: Path
    data_dir: Path
    enabled: bool
    manifest: PluginManifest | None = None
    skills: tuple[SkillEntry, ...] = ()
    mcp_servers: tuple[PluginMCPServer, ...] = ()
    issues: tuple[PluginIssue, ...] = field(default=())

    @property
    def valid(self) -> bool:
        """False when the manifest was rejected — nothing of it may run."""
        return self.manifest is not None

    @property
    def active(self) -> bool:
        """True when this plugin's components should reach the agent."""
        return self.valid and self.enabled


class PluginRegistry:
    """Scans the plugins root and caches what it found."""

    def __init__(self, plugins_dir: Path, data_dir: Path) -> None:
        self.plugins_dir = plugins_dir
        self.data_dir = data_dir
        self._plugins: dict[str, LoadedPlugin] = {}
        self._disabled: set[str] = set()
        self._signature: tuple[tuple[str, float], ...] | None = None

    # ── state ────────────────────────────────────────────────────────────

    def set_disabled(self, names: Iterable[str]) -> None:
        """Replace the disabled set (persisted by the settings store)."""
        incoming = {str(n) for n in names}
        if incoming != self._disabled:
            self._disabled = incoming
            self.invalidate()

    def invalidate(self) -> None:
        """Force the next :meth:`rebuild` to re-read from disk."""
        self._signature = None

    # ── loading ──────────────────────────────────────────────────────────

    def rebuild(self, force: bool = False) -> None:
        """Re-scan the plugins root unless nothing has changed since last time."""
        signature = self._directory_signature()
        if not force and signature is not None and signature == self._signature:
            return
        self._plugins = {p.name: p for p in self._load_all()}
        self._signature = signature

    def _directory_signature(self) -> tuple[tuple[str, float], ...] | None:
        """Cheap change detector: the mtime of the root and of each plugin dir.

        Catches installs, uninstalls and edits to a plugin's own top level —
        the same guarantee ``AgentSkillsReader`` gives, for the same reason: a
        deep watch costs more than the occasional stale read is worth.
        """
        try:
            entries = [(".", self.plugins_dir.stat().st_mtime)]
            for child in sorted(self.plugins_dir.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    entries.append((child.name, child.stat().st_mtime))
            return tuple(entries)
        except OSError:
            return None

    def _load_all(self) -> list[LoadedPlugin]:
        try:
            children = sorted(
                p
                for p in self.plugins_dir.iterdir()
                # A dot-prefixed directory is the installer's staging area
                # mid-install, not a plugin.
                if p.is_dir() and not p.name.startswith(".")
            )
        except OSError:
            return []
        loaded: list[LoadedPlugin] = []
        for child in children:
            if not (child / MANIFEST_FILE_NAME).exists():
                continue  # not a plugin package; leave it alone
            try:
                loaded.append(self._load_one(child))
            except Exception as exc:  # noqa: BLE001 — one bad plugin must not break the scan
                logger.warning("Could not load plugin %r: %s", child.name, exc)
                loaded.append(
                    LoadedPlugin(
                        name=child.name,
                        root=child,
                        data_dir=self.data_dir / child.name,
                        enabled=child.name not in self._disabled,
                        issues=(
                            PluginIssue(
                                level="error", scope="manifest", message=f"Failed to load: {exc}"
                            ),
                        ),
                    )
                )
        return loaded

    def _load_one(self, root: Path) -> LoadedPlugin:
        name = root.name
        data_dir = self.data_dir / name
        enabled = name not in self._disabled

        result = load_manifest(root)
        issues: list[PluginIssue] = list(result.issues)
        if result.manifest is None:
            # A rejected manifest stops everything: no component of this
            # plugin may be discovered or executed.
            return LoadedPlugin(
                name=name, root=root, data_dir=data_dir, enabled=enabled, issues=tuple(issues)
            )

        manifest = result.manifest
        if manifest.name != name:
            issues.append(
                PluginIssue(
                    level="warning",
                    scope="manifest",
                    message=f"Manifest name {manifest.name!r} differs from directory {name!r}",
                    target="name",
                )
            )

        skill_result = discover_skills(root, manifest.name)
        issues.extend(skill_result.issues)

        mcp_result = load_mcp_config(
            plugin_name=manifest.name,
            plugin_root=root,
            plugin_data=data_dir,
            spec_version=SCHEMA_VERSIONS[manifest.schema_id],
        )
        issues.extend(mcp_result.issues)

        # §9.1 — PLUGIN_DATA must exist and be writable *before* a subprocess
        # starts. Created only for a plugin that will actually launch one, so a
        # scan does not litter the data root.
        if enabled and any(s.transport == "stdio" for s in mcp_result.servers):
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                issues.append(
                    PluginIssue(
                        level="error",
                        scope="mcp",
                        message=f"Cannot create the plugin data directory: {exc}",
                    )
                )

        return LoadedPlugin(
            name=name,
            root=root,
            data_dir=data_dir,
            enabled=enabled,
            manifest=manifest,
            skills=skill_result.skills,
            mcp_servers=mcp_result.servers,
            issues=tuple(issues),
        )

    # ── queries ──────────────────────────────────────────────────────────

    def list_plugins(self) -> list[LoadedPlugin]:
        self.rebuild()
        return sorted(self._plugins.values(), key=lambda p: p.name)

    def get(self, name: str) -> LoadedPlugin | None:
        self.rebuild()
        return self._plugins.get(name)

    def skill_entries(self) -> list[SkillEntry]:
        """Skills contributed by every enabled, valid plugin."""
        self.rebuild()
        entries: list[SkillEntry] = []
        for plugin in sorted(self._plugins.values(), key=lambda p: p.name):
            if plugin.active:
                entries.extend(plugin.skills)
        return entries

    def mcp_servers(self) -> list[MCPServerConfig]:
        """MCP configs contributed by every enabled, valid plugin."""
        self.rebuild()
        servers: list[MCPServerConfig] = []
        for plugin in sorted(self._plugins.values(), key=lambda p: p.name):
            if plugin.active:
                servers.extend(s.config for s in plugin.mcp_servers)
        return servers

    def render_prompt(self) -> str:
        """The installed-plugin roster for the system prompt.

        Only active plugins appear: a disabled or rejected one contributes
        nothing the model could act on, and listing it would invite the model
        to reach for a skill that is not in its index. The package directory is
        included because it is the one fact about a plugin the model cannot
        otherwise obtain — ``read_skill`` shows a skill's own folder, never the
        README, examples or references sitting beside it.
        """
        self.rebuild()
        entries = [p for p in self.list_plugins() if p.active]
        if not entries:
            return ""

        lines: list[str] = []
        for plugin in entries:
            manifest = plugin.manifest
            assert manifest is not None  # active implies a validated manifest
            version = f" (v{manifest.version})" if manifest.version else ""
            summary = f" — {manifest.description}" if manifest.description else ""
            lines.append(f"- **{manifest.name}**{version}{summary}")
            if plugin.skills:
                names = ", ".join(f"`{s.name}`" for s in plugin.skills)
                lines.append(f"  - Skills: {names}")
            if plugin.mcp_servers:
                names = ", ".join(
                    f"`{s.key}` ({s.transport})" for s in plugin.mcp_servers
                )
                lines.append(f"  - MCP servers: {names}")
            lines.append(f"  - Package directory: {plugin.root}")
        return _PROMPT_TEMPLATE.format(plugins="\n".join(lines))

    def apply_to_reader(self, reader: AgentSkillsReader) -> None:
        """Push the current plugin skills into the shared skills index.

        Called wherever the index is about to be read, because enabling or
        installing a plugin changes nothing about the mtimes the reader
        watches — its own cache would otherwise hide the change.
        """
        reader.set_plugin_skills(self.skill_entries())

    def owns_server(self, server_id: str) -> str | None:
        """Name of the plugin that contributes *server_id*, if any."""
        self.rebuild()
        for plugin in self._plugins.values():
            if any(s.config.id == server_id for s in plugin.mcp_servers):
                return plugin.name
        return None
