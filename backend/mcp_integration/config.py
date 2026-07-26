"""Pydantic models for MCP server configuration.

These types are persisted inside ``settings.json`` under the ``mcp.servers``
block and round-tripped over the ``/api/mcp/servers`` endpoints.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from api.schemas.redaction import redact_map

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")

# Transport fields that carry credentials: stdio env vars and HTTP auth
# headers. Both are user-defined maps, so the backend cannot tell a token from
# a harmless variable and treats the whole map as secret. Single source of
# truth for masking (here) and for the settings.json secret split
# (store/settings_io.py).
MCP_SECRET_FIELDS = ("env", "headers")


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
    unchanged (see api.schemas.redaction).
    """
    out = cfg.model_copy(deep=True)
    for field in MCP_SECRET_FIELDS:
        current = getattr(out.config, field, None)
        if isinstance(current, dict):
            setattr(out.config, field, redact_map(current) or {})
    return out
