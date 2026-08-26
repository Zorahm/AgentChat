"""MCP contracts: the persisted server config and the API's response models.

The persisted models (:class:`MCPServerConfig` and friends) live under
``settings.json``'s ``mcp.servers`` block and round-trip over the
``/api/mcp/servers`` endpoints. They used to sit in ``mcp_integration.config``
purely so the persistence layer could share them without an import cycle; with
the contracts collected here that split no longer buys anything, and keeping
them out of ``mcp_integration`` stops a settings contract from dragging the
process supervisor (and asyncio, ssl, subprocess) in behind it.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from schemas.redaction import redact_map

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")

# Transport fields that carry credentials: stdio env vars and HTTP auth
# headers. Both are user-defined maps, so the backend cannot tell a token from
# a harmless variable and treats the whole map as secret. Single source of
# truth for masking (here) and for the settings.json secret split
# (store/settings_io.py).
MCP_SECRET_FIELDS = ("env", "headers")


# ── persisted server config ──────────────────────────────────────────────────


class MCPStdioConfig(BaseModel):
    """stdio MCP server — launched as a subprocess."""

    transport: Literal["stdio"] = "stdio"
    command: str = Field(min_length=1)
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    # ``host`` runs the command in the parent process environment (Windows
    # or Linux). ``wsl`` wraps it in ``wsl.exe -- bash -lc`` so Linux-only
    # tooling (npx/uvx in WSL) works from a Windows host.
    runtime: Literal["host", "wsl"] = "host"
    # Working directory for the subprocess. ``None`` inherits the backend's,
    # which is what a hand-configured server has always done. Agent Plugins
    # requires a plugin's server to default to its plugin root instead, so the
    # plugins layer fills this in with an already-resolved absolute path.
    cwd: str | None = None


class MCPHttpConfig(BaseModel):
    """Streamable HTTP MCP server — connected over HTTPS/HTTP."""

    transport: Literal["http"] = "http"
    url: str = Field(min_length=1)
    headers: dict[str, str] = Field(default_factory=dict)


MCPTransportConfig = Annotated[
    MCPStdioConfig | MCPHttpConfig,
    Field(discriminator="transport"),
]


class MCPServerConfig(BaseModel):
    """One configured MCP server.

    ``enabled`` is a global kill-switch — disabled servers are never spawned
    even if a chat references them. Per-chat opt-in is stored separately on
    the chat row.
    """

    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)
    name: str = Field(min_length=1)
    enabled: bool = True
    config: MCPTransportConfig


class MCPServerCreate(BaseModel):
    id: str = Field(min_length=1, pattern=_SLUG_RE.pattern)
    name: str = Field(min_length=1)
    enabled: bool = True
    config: MCPTransportConfig


class MCPServerUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    config: MCPTransportConfig | None = None


def is_valid_server_id(value: str) -> bool:
    """Slug guard used outside Pydantic-validated paths."""
    return bool(_SLUG_RE.match(value))


def redact_mcp_server(cfg: MCPServerConfig) -> MCPServerConfig:
    """Copy of *cfg* with credential values masked, for API responses.

    Returns the same type rather than a parallel "public" model: only the
    values change, and the UI's server editor round-trips the mask back
    unchanged (see schemas.redaction).
    """
    out = cfg.model_copy(deep=True)
    for field in MCP_SECRET_FIELDS:
        current = getattr(out.config, field, None)
        if isinstance(current, dict):
            setattr(out.config, field, redact_map(current) or {})
    return out


# ── API response models ──────────────────────────────────────────────────────


class MCPServerView(BaseModel):
    """A server entry decorated with live runtime status — for the UI list."""

    id: str
    name: str
    enabled: bool
    config: dict[str, Any]
    state: str  # "stopped" | "running" | "error"
    last_error: str | None = None
    tool_count: int = 0
    last_used: float | None = None
    # Name of the Agent Plugin contributing this server, when it is not a
    # user-configured one. Such a server is read-only here: its definition
    # lives in the plugin's mcp.json, and the plugin's own toggle is what
    # turns it off.
    plugin: str | None = None


class MCPToolView(BaseModel):
    """A single tool advertised by an MCP server."""

    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class MCPImportPayload(BaseModel):
    """Bulk import format compatible with ``claude_desktop_config.json``.

    Accepts either ``{ "mcpServers": { id: {...} } }`` or a bare
    ``{ id: {...} }`` mapping. Each value mirrors the canonical
    ``{ command, args, env }`` or ``{ url, headers }`` shape.
    """

    mcpServers: dict[str, dict[str, Any]] | None = None
    servers: dict[str, dict[str, Any]] | None = None


class MCPTestResult(BaseModel):
    """Outcome of a ``POST /mcp/servers/{id}/test`` call."""

    ok: bool
    tools: list[MCPToolView] = Field(default_factory=list)
    error: str | None = None


class MCPInstallRequest(BaseModel):
    """A one-shot install command pasted from an MCP server's README.

    Runs on the *host* shell (PowerShell or CMD) — never WSL — since that is
    where npx/uvx-based installers expect to write their config.
    """

    command: str = Field(min_length=1)
    shell: Literal["powershell", "cmd"] = "powershell"


class MCPInstallResult(BaseModel):
    """Outcome of a ``POST /mcp/install`` run — combined output + exit code."""

    ok: bool
    exit_code: int
    output: str
    timed_out: bool = False
