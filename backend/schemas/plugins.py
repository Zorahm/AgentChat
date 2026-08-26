"""Agent Plugins contracts — the manifest and the API's plugin views.

Implements the data half of the `Agent Plugins 1.0.0 specification
<https://agent-plugins.org/specification>`_: a plugin is a directory holding a
``plugin.json`` manifest plus components in fixed locations (``skills/`` and
``mcp.json``).

A leaf, like every other module in ``schemas/`` — the validation *rules* live
in ``plugins/manifest.py`` because several of them (unknown field, non-object
``extensions``) are non-fatal and must be *reported* rather than raised, which
is more than a Pydantic model can express.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# §5.2 / §7.2.1 — the canonical schema identifiers for Agent Plugins 1.0.0.
# Matching is exact and offline: a client selects locally supported rules from
# `$schema` and MUST NOT retrieve the document while loading a plugin.
PLUGIN_SCHEMA_1_0_0 = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA_1_0_0 = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

SUPPORTED_PLUGIN_SCHEMAS: frozenset[str] = frozenset({PLUGIN_SCHEMA_1_0_0})
SUPPORTED_MCP_SCHEMAS: frozenset[str] = frozenset({MCP_SCHEMA_1_0_0})

# The spec version each schema identifier stands for. `mcp.json` must target
# the same Agent Plugins version as `plugin.json` (§7.2.2 rule 2), and the two
# identifiers differ in their filename, so they are compared through this map
# rather than as strings.
SCHEMA_VERSIONS: dict[str, str] = {
    PLUGIN_SCHEMA_1_0_0: "1.0.0",
    MCP_SCHEMA_1_0_0: "1.0.0",
}

# §5.2 — the manifest schema is *closed*: these are the only permitted
# top-level fields. Anything else is reported and ignored, never assigned
# semantics.
MANIFEST_FIELDS: frozenset[str] = frozenset(
    {
        "$schema",
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "extensions",
    }
)

# §5.5 — 1-64 chars, lowercase alphanumerics plus `-` and `.`, alphanumeric at
# both ends, no `--` or `..`. Expressed as one pattern plus a repetition check
# the caller does separately (a regex for "no doubled separator" reads worse
# than the two-line loop it replaces).
PLUGIN_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.\-]{0,62}[a-z0-9])?$")

# §9.1 — supplied by the client, never by the plugin. An MCP entry that sets
# either name in its own `env` is invalid.
RESERVED_PLUGIN_VARS: tuple[str, str] = ("PLUGIN_ROOT", "PLUGIN_DATA")

# §6.1 — fixed component locations, relative to the plugin root.
SKILLS_DIR_NAME = "skills"
MCP_FILE_NAME = "mcp.json"
MANIFEST_FILE_NAME = "plugin.json"


def is_valid_plugin_name(value: str) -> bool:
    """True iff *value* satisfies every §5.5 constraint."""
    if not 1 <= len(value) <= 64:
        return False
    if not PLUGIN_NAME_RE.match(value):
        return False
    return "--" not in value and ".." not in value


# ── manifest ─────────────────────────────────────────────────────────────────


class PluginAuthor(BaseModel):
    """§5.4 — the author object admits `name`, `email` and `url` and nothing else.

    ``extra="forbid"`` is deliberate: unlike an unknown *top-level* manifest
    field, an unknown field here makes the whole manifest invalid.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    email: str | None = None
    url: str | None = None


class PluginManifest(BaseModel):
    """A validated ``plugin.json``.

    Only ``$schema`` and ``name`` are required (§5.3). The metadata fields are
    checked by JSON type alone — the spec explicitly forbids rejecting a
    manifest because ``version`` is not semver, ``license`` is not an SPDX id,
    or a URL field does not parse.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    schema_id: str = Field(alias="$schema", min_length=1)
    name: str = Field(min_length=1, max_length=64)
    version: str | None = None
    description: str | None = None
    author: PluginAuthor | None = None
    homepage: str | None = None
    repository: str | None = None
    license: str | None = None
    keywords: list[str] | None = None
    extensions: dict[str, dict[str, Any]] | None = None


# ── API views ────────────────────────────────────────────────────────────────

IssueLevel = Literal["error", "warning"]
IssueScope = Literal["manifest", "skill", "mcp", "extension"]


class PluginIssue(BaseModel):
    """One thing the loader refused or ignored, kept for the UI.

    The spec pairs almost every "MUST skip" with a "SHOULD report"; without
    this the failure isolation it demands would make a broken component simply
    vanish, which is indistinguishable from a plugin that never had one.
    """

    level: IssueLevel
    scope: IssueScope
    message: str
    target: str | None = None  # field name, skill directory, or server key


class PluginSkillInfo(BaseModel):
    """A skill discovered inside a plugin's ``skills/`` directory."""

    name: str
    description: str = ""
    path: str


class PluginMCPServerInfo(BaseModel):
    """One entry from a plugin's ``mcp.json``, decorated with live status."""

    id: str  # the synthetic MCPServerConfig id the manager knows it by
    key: str  # the name it has inside mcp.json
    transport: str  # "stdio" | "streamable-http"
    state: str = "stopped"  # "stopped" | "running" | "error"
    last_error: str | None = None
    tool_count: int = 0


class PluginInfo(BaseModel):
    """A plugin as the Plugins tab renders it.

    ``valid`` is false when the manifest itself was rejected — the plugin is
    still listed, because a plugin that disappears with no explanation is
    worse than one shown with its error.
    """

    name: str  # directory name; equals manifest.name for a valid plugin
    path: str
    valid: bool
    enabled: bool
    version: str | None = None
    description: str | None = None
    author: str | None = None
    homepage: str | None = None
    repository: str | None = None
    license: str | None = None
    keywords: list[str] = Field(default_factory=list)
    source: str | None = None  # install marker: "owner/repo", "local:…", …
    installed_by_us: bool = False
    skills: list[PluginSkillInfo] = Field(default_factory=list)
    mcp_servers: list[PluginMCPServerInfo] = Field(default_factory=list)
    issues: list[PluginIssue] = Field(default_factory=list)


# ── requests ─────────────────────────────────────────────────────────────────


class PluginInstallRequest(BaseModel):
    """Install from GitHub — ``owner/repo``, optionally ``owner/repo/subdir``."""

    source: str = Field(min_length=1)


class PluginInstallLocalRequest(BaseModel):
    """Install by copying a directory that already sits on this machine."""

    path: str = Field(min_length=1)


class PluginUpdateRequest(BaseModel):
    """The only mutable bit of an installed plugin: whether it loads."""

    enabled: bool
