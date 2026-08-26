"""``mcp.json`` translation — Agent Plugins §7.2 and §9.

Turns a plugin's portable MCP configuration into the client's own
:class:`~schemas.mcp.MCPServerConfig`, applying the two failure boundaries the
spec draws: a bad *document* disables MCP for that plugin and nothing else,
while a bad *entry* skips one server and nothing else.

Values arrive already expanded — ``${PLUGIN_ROOT}`` and ``${PLUGIN_DATA}`` are
resolved here, once, and only in the three fields the spec names (``args``,
``env`` values, ``cwd``). ``command`` is never expanded: it is one executable
token, either plugin-relative or resolved by the platform's own search.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from plugins.safety import resolve_relative, resolve_within
from plugins.variables import expand, plugin_server_id
from schemas.mcp import MCPHttpConfig, MCPServerConfig, MCPStdioConfig
from schemas.plugins import (
    MCP_FILE_NAME,
    RESERVED_PLUGIN_VARS,
    SCHEMA_VERSIONS,
    SUPPORTED_MCP_SCHEMAS,
    PluginIssue,
)

_TOP_LEVEL_FIELDS = frozenset({"$schema", "mcpServers"})
_STDIO_FIELDS = frozenset({"type", "command", "args", "env", "cwd"})
_REMOTE_FIELDS = frozenset({"type", "url", "headers"})

# RFC 9110 field name (a token) and field value (visible ASCII plus SP/HTAB).
_TOKEN_CHARS = frozenset("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")


@dataclass(frozen=True)
class PluginMCPServer:
    """One server entry that survived validation, ready for the manager."""

    key: str  # its name inside mcp.json
    transport: str  # "stdio" | "streamable-http"
    config: MCPServerConfig


@dataclass(frozen=True)
class MCPConfigResult:
    servers: tuple[PluginMCPServer, ...] = ()
    issues: tuple[PluginIssue, ...] = ()


def _error(message: str, target: str | None = None) -> PluginIssue:
    return PluginIssue(level="error", scope="mcp", message=message, target=target)


def _warning(message: str, target: str | None = None) -> PluginIssue:
    return PluginIssue(level="warning", scope="mcp", message=message, target=target)


def load_mcp_config(
    *,
    plugin_name: str,
    plugin_root: Path,
    plugin_data: Path,
    spec_version: str,
) -> MCPConfigResult:
    """Read ``<plugin_root>/mcp.json`` and translate every valid server entry.

    *spec_version* is the Agent Plugins version ``plugin.json`` targets; a
    configuration aimed at a different version is rejected rather than
    guessed at (§7.2.2 rule 2).
    """
    path = plugin_root / MCP_FILE_NAME
    if not path.exists():
        return MCPConfigResult()  # §6.2 — an absent component location is not an error
    if not path.is_file():
        return MCPConfigResult(issues=(_error(f"{MCP_FILE_NAME} is not a regular file"),))
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        return MCPConfigResult(issues=(_error(f"Cannot read {MCP_FILE_NAME}: {exc}"),))
    except json.JSONDecodeError as exc:
        return MCPConfigResult(issues=(_error(f"{MCP_FILE_NAME} is not valid JSON: {exc}"),))

    document_issue = _check_document(raw, spec_version)
    if document_issue is not None:
        return MCPConfigResult(issues=(document_issue,))

    servers: list[PluginMCPServer] = []
    issues: list[PluginIssue] = []
    for key, entry in sorted(raw["mcpServers"].items()):
        server, entry_issues = _build_server(
            key=key,
            entry=entry,
            plugin_name=plugin_name,
            plugin_root=plugin_root,
            plugin_data=plugin_data,
        )
        issues.extend(entry_issues)
        if server is not None:
            servers.append(server)
    return MCPConfigResult(tuple(servers), tuple(issues))


def _check_document(raw: Any, spec_version: str) -> PluginIssue | None:
    """Validate the top level. A failure here disables MCP for the plugin."""
    if not isinstance(raw, dict):
        return _error(f"{MCP_FILE_NAME} must contain a JSON object")
    unknown = sorted(set(raw) - _TOP_LEVEL_FIELDS)
    if unknown:
        return _error(f"{MCP_FILE_NAME} has unexpected top-level fields: {', '.join(unknown)}")
    schema_id = raw.get("$schema")
    if not isinstance(schema_id, str) or schema_id not in SUPPORTED_MCP_SCHEMAS:
        return _error(f"Unsupported {MCP_FILE_NAME} schema: {schema_id!r}", target="$schema")
    if SCHEMA_VERSIONS[schema_id] != spec_version:
        return _error(
            f"{MCP_FILE_NAME} targets Agent Plugins {SCHEMA_VERSIONS[schema_id]} but "
            f"plugin.json targets {spec_version}",
            target="$schema",
        )
    if not isinstance(raw.get("mcpServers"), dict):
        return _error("'mcpServers' must be an object", target="mcpServers")
    return None


def _build_server(
    *,
    key: str,
    entry: Any,
    plugin_name: str,
    plugin_root: Path,
    plugin_data: Path,
) -> tuple[PluginMCPServer | None, list[PluginIssue]]:
    """Validate and translate one entry. ``None`` means "skip this server"."""
    if not isinstance(entry, dict):
        return None, [_error("Server entry must be an object", target=key)]

    kind = entry.get("type")
    if kind == "stdio":
        return _build_stdio(
            key=key,
            entry=entry,
            plugin_name=plugin_name,
            plugin_root=plugin_root,
            plugin_data=plugin_data,
        )
    if kind in ("streamable-http", "sse"):
        return _build_remote(key=key, entry=entry, plugin_name=plugin_name, kind=str(kind))
    return None, [_error(f"Unknown transport {kind!r}", target=key)]


def _build_stdio(
    *,
    key: str,
    entry: dict[str, Any],
    plugin_name: str,
    plugin_root: Path,
    plugin_data: Path,
) -> tuple[PluginMCPServer | None, list[PluginIssue]]:
    unknown = sorted(set(entry) - _STDIO_FIELDS)
    if unknown:
        return None, [_error(f"Unexpected fields: {', '.join(unknown)}", target=key)]

    command = entry.get("command")
    if not isinstance(command, str) or not command:
        return None, [_error("stdio server needs a non-empty 'command'", target=key)]
    resolved_command = _resolve_command(command, plugin_root)
    if resolved_command is None:
        return None, [
            _error(
                f"Command {command!r} is neither a bare executable name nor a "
                "'./' path inside the plugin",
                target=key,
            )
        ]

    raw_args = entry.get("args", [])
    if not isinstance(raw_args, list) or not all(isinstance(a, str) for a in raw_args):
        return None, [_error("'args' must be an array of strings", target=key)]

    raw_env = entry.get("env", {})
    if not isinstance(raw_env, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in raw_env.items()
    ):
        return None, [_error("'env' must be an object of strings", target=key)]
    reserved = sorted(set(raw_env) & set(RESERVED_PLUGIN_VARS))
    if reserved:
        # §9.2 — the client supplies these; a plugin that sets them is invalid
        # rather than silently overridden.
        return None, [_error(f"'env' may not set {', '.join(reserved)}", target=key)]

    cwd = plugin_root
    raw_cwd = entry.get("cwd")
    if raw_cwd is not None:
        if not isinstance(raw_cwd, str):
            return None, [_error("'cwd' must be a string", target=key)]
        resolved_cwd = _resolve_cwd(raw_cwd, plugin_root, plugin_data)
        if resolved_cwd is None:
            return None, [
                _error(
                    f"Working directory {raw_cwd!r} must start with './', "
                    "'${PLUGIN_ROOT}' or '${PLUGIN_DATA}' and stay inside it",
                    target=key,
                )
            ]
        cwd = resolved_cwd

    env = {k: expand(v, plugin_root, plugin_data) for k, v in raw_env.items()}
    # §9.1 — the reserved variables go on last so they win. There is nothing
    # here for them to overwrite: an entry that declared them was rejected above.
    env[RESERVED_PLUGIN_VARS[0]] = str(plugin_root)
    env[RESERVED_PLUGIN_VARS[1]] = str(plugin_data)

    config = MCPServerConfig(
        id=plugin_server_id(plugin_name, key),
        name=f"{plugin_name}: {key}",
        enabled=True,  # the plugin's own toggle is the kill switch
        config=MCPStdioConfig(
            command=resolved_command,
            args=[expand(a, plugin_root, plugin_data) for a in raw_args],
            env=env,
            runtime="host",
            cwd=str(cwd),
        ),
    )
    return PluginMCPServer(key=key, transport="stdio", config=config), []


def _build_remote(
    *, key: str, entry: dict[str, Any], plugin_name: str, kind: str
) -> tuple[PluginMCPServer | None, list[PluginIssue]]:
    unknown = sorted(set(entry) - _REMOTE_FIELDS)
    if unknown:
        return None, [_error(f"Unexpected fields: {', '.join(unknown)}", target=key)]

    url = entry.get("url")
    if not isinstance(url, str) or not url:
        return None, [_error(f"{kind} server needs a non-empty 'url'", target=key)]
    url_problem = _check_url(url)
    if url_problem is not None:
        return None, [_error(url_problem, target=key)]

    raw_headers = entry.get("headers", {})
    if not isinstance(raw_headers, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in raw_headers.items()
    ):
        return None, [_error("'headers' must be an object of strings", target=key)]
    header_problem = _check_headers(raw_headers)
    if header_problem is not None:
        return None, [_error(header_problem, target=key)]

    if kind == "sse":
        # Legacy HTTP+SSE is optional for a conformant client (§11.1) and we
        # do not implement it. Skipping one entry must not disturb the rest.
        return None, [_warning("Legacy 'sse' transport is not supported", target=key)]

    config = MCPServerConfig(
        id=plugin_server_id(plugin_name, key),
        name=f"{plugin_name}: {key}",
        enabled=True,
        config=MCPHttpConfig(url=url, headers=dict(raw_headers)),
    )
    return PluginMCPServer(key=key, transport="streamable-http", config=config), []


def _resolve_command(command: str, plugin_root: Path) -> str | None:
    """Return the command to execute, or ``None`` if the form is not allowed.

    Two forms exist: a ``./`` path resolved against the plugin root, and a bare
    name left for the platform's executable search. Anything else — an
    absolute path, ``../bin/x``, a nested ``bin/x`` — is neither.
    """
    if command.startswith("./"):
        resolved = resolve_relative(plugin_root, command)
        return str(resolved) if resolved is not None else None
    if Path(command).is_absolute() or "/" in command or "\\" in command:
        return None
    return command


def _resolve_cwd(value: str, plugin_root: Path, plugin_data: Path) -> Path | None:
    """Validate a ``cwd``'s declared form and its post-resolution containment."""
    for placeholder, root in (
        ("${PLUGIN_ROOT}", plugin_root),
        ("${PLUGIN_DATA}", plugin_data),
    ):
        if value == placeholder or value.startswith(f"{placeholder}/"):
            return resolve_within(root, Path(expand(value, plugin_root, plugin_data)))
    return resolve_relative(plugin_root, value)


def _check_url(url: str) -> str | None:
    """Apply §7.2.1's URL rules. Returns a message, or ``None`` when valid."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return f"URL must be absolute http(s): {url!r}"
    if not parts.hostname:
        return f"URL has no host: {url!r}"
    if parts.username or parts.password:
        return "URL must not carry user information"
    if parts.fragment:
        return "URL must not carry a fragment"
    if parts.scheme == "http" and not _is_loopback(parts.hostname):
        return "Plain http is only allowed for loopback hosts"
    return None


def _is_loopback(host: str) -> bool:
    """Exactly ``localhost``, or an IP literal in a loopback range."""
    if host == "localhost":
        return True
    try:
        return ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _check_headers(headers: dict[str, str]) -> str | None:
    """Reject malformed field names/values and case-insensitive duplicates."""
    seen: set[str] = set()
    for name, value in headers.items():
        if not name or not set(name) <= _TOKEN_CHARS:
            return f"Invalid header name {name!r}"
        lowered = name.lower()
        if lowered in seen:
            return f"Header {name!r} is repeated under different casing"
        seen.add(lowered)
        if any(ch in "\r\n\0" for ch in value) or any(
            ord(ch) < 0x20 and ch != "\t" for ch in value
        ):
            return f"Invalid value for header {name!r}"
    return None
