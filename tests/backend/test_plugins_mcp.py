"""Agent Plugins §7.2/§9 — MCP configuration, variables and failure isolation.

Two boundaries are pinned here and neither is cosmetic. A bad *document*
disables MCP for one plugin and touches nothing else; a bad *entry* skips one
server and touches nothing else. Collapsing either one turns a typo in someone
else's plugin into a client that loses tools it still has.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from plugins.mcp_config import load_mcp_config
from plugins.variables import expand, plugin_server_id
from schemas.mcp import MCPHttpConfig, MCPStdioConfig
from schemas.plugins import MCP_SCHEMA_1_0_0


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "pkg"
    data = tmp_path / "data"
    root.mkdir()
    data.mkdir()
    return root, data


def _write(root: Path, servers: dict[str, Any], *, schema: str = MCP_SCHEMA_1_0_0) -> None:
    (root / "mcp.json").write_text(
        json.dumps({"$schema": schema, "mcpServers": servers}), encoding="utf-8"
    )


def _load(roots: tuple[Path, Path], **kwargs: Any):
    root, data = roots
    return load_mcp_config(
        plugin_name=kwargs.pop("plugin_name", "demo"),
        plugin_root=root,
        plugin_data=data,
        spec_version=kwargs.pop("spec_version", "1.0.0"),
    )


# ── document-level failures ──────────────────────────────────────────────


def test_absent_mcp_json_is_not_an_error(roots: tuple[Path, Path]) -> None:
    result = _load(roots)
    assert result.servers == ()
    assert result.issues == ()


def test_empty_server_map_is_valid(roots: tuple[Path, Path]) -> None:
    _write(roots[0], {})
    result = _load(roots)
    assert result.servers == ()
    assert result.issues == ()


@pytest.mark.parametrize(
    "document",
    [
        pytest.param("{ not json", id="malformed"),
        pytest.param('{"mcpServers": {}}', id="no-schema"),
        pytest.param('{"$schema": "https://example.com/x.json", "mcpServers": {}}', id="alien"),
        pytest.param(
            json.dumps({"$schema": MCP_SCHEMA_1_0_0, "mcpServers": {}, "extra": 1}),
            id="extra-top-level",
        ),
        pytest.param(
            json.dumps({"$schema": MCP_SCHEMA_1_0_0, "mcpServers": []}), id="servers-not-object"
        ),
    ],
)
def test_document_failure_disables_mcp_for_the_plugin(
    roots: tuple[Path, Path], document: str
) -> None:
    (roots[0] / "mcp.json").write_text(document, encoding="utf-8")
    result = _load(roots)
    assert result.servers == ()
    assert [i.level for i in result.issues] == ["error"]


def test_version_mismatch_with_the_manifest_is_rejected(roots: tuple[Path, Path]) -> None:
    _write(roots[0], {"a": {"type": "stdio", "command": "npx"}})
    result = _load(roots, spec_version="2.0.0")
    assert result.servers == ()
    assert "targets Agent Plugins" in result.issues[0].message


# ── stdio entries ────────────────────────────────────────────────────────


def test_stdio_defaults_cwd_to_the_plugin_root(roots: tuple[Path, Path]) -> None:
    root, data = roots
    _write(root, {"validator": {"type": "stdio", "command": "npx"}})
    server = _load(roots).servers[0]
    assert isinstance(server.config.config, MCPStdioConfig)
    assert server.config.config.cwd == str(root)
    assert server.config.config.command == "npx"
    assert server.config.config.runtime == "host"


def test_plugin_relative_command_becomes_absolute(roots: tuple[Path, Path]) -> None:
    root, _ = roots
    (root / "bin").mkdir()
    (root / "bin" / "server").write_text("#!/bin/sh\n", encoding="utf-8")
    _write(root, {"a": {"type": "stdio", "command": "./bin/server"}})
    config = _load(roots).servers[0].config.config
    assert isinstance(config, MCPStdioConfig)
    assert Path(config.command) == (root / "bin" / "server").resolve()


@pytest.mark.parametrize("command", ["../bin/server", "bin/server", "/usr/bin/server"])
def test_command_forms_outside_the_two_allowed_ones_are_skipped(
    roots: tuple[Path, Path], command: str
) -> None:
    _write(roots[0], {"a": {"type": "stdio", "command": command}})
    result = _load(roots)
    assert result.servers == ()
    assert result.issues[0].target == "a"


def test_reserved_env_names_invalidate_the_entry(roots: tuple[Path, Path]) -> None:
    _write(
        roots[0],
        {"a": {"type": "stdio", "command": "npx", "env": {"PLUGIN_ROOT": "/tmp/anywhere"}}},
    )
    result = _load(roots)
    assert result.servers == ()
    assert "PLUGIN_ROOT" in result.issues[0].message


def test_client_supplies_the_reserved_variables(roots: tuple[Path, Path]) -> None:
    root, data = roots
    _write(root, {"a": {"type": "stdio", "command": "npx", "env": {"MODE": "fast"}}})
    config = _load(roots).servers[0].config.config
    assert isinstance(config, MCPStdioConfig)
    assert config.env["MODE"] == "fast"
    assert config.env["PLUGIN_ROOT"] == str(root)
    assert config.env["PLUGIN_DATA"] == str(data)


@pytest.mark.parametrize(
    "cwd,expected",
    [("./data", "root/data"), ("${PLUGIN_ROOT}", "root"), ("${PLUGIN_DATA}/work", "data/work")],
)
def test_accepted_cwd_forms(roots: tuple[Path, Path], cwd: str, expected: str) -> None:
    root, data = roots
    _write(root, {"a": {"type": "stdio", "command": "npx", "cwd": cwd}})
    config = _load(roots).servers[0].config.config
    assert isinstance(config, MCPStdioConfig)
    base, _, tail = expected.partition("/")
    anchor = root if base == "root" else data
    assert Path(config.cwd or "") == (anchor / tail if tail else anchor).resolve()


@pytest.mark.parametrize("cwd", ["data", "../elsewhere", "./../elsewhere", "/etc", ""])
def test_rejected_cwd_forms_skip_the_entry(roots: tuple[Path, Path], cwd: str) -> None:
    _write(roots[0], {"a": {"type": "stdio", "command": "npx", "cwd": cwd}})
    result = _load(roots)
    assert result.servers == ()
    assert result.issues[0].target == "a"


# ── §9.2 placeholder expansion ───────────────────────────────────────────


def test_expansion_applies_to_args_env_and_cwd(roots: tuple[Path, Path]) -> None:
    root, data = roots
    _write(
        root,
        {
            "a": {
                "type": "stdio",
                "command": "npx",
                "args": ["--config", "${PLUGIN_ROOT}/config/db.json"],
                "env": {"DATA_DIR": "${PLUGIN_DATA}/database"},
            }
        },
    )
    config = _load(roots).servers[0].config.config
    assert isinstance(config, MCPStdioConfig)
    assert config.args == ["--config", f"{root}/config/db.json"]
    assert config.env["DATA_DIR"] == f"{data}/database"


def test_unrecognised_placeholders_stay_literal(roots: tuple[Path, Path]) -> None:
    _write(
        roots[0],
        {"a": {"type": "stdio", "command": "npx", "args": ["${HOME}", "$PLUGIN_ROOT", "${}"]}},
    )
    config = _load(roots).servers[0].config.config
    assert isinstance(config, MCPStdioConfig)
    assert config.args == ["${HOME}", "$PLUGIN_ROOT", "${}"]


def test_expansion_is_not_recursive(tmp_path: Path) -> None:
    """Text a replacement introduces must not be scanned again."""
    sneaky = tmp_path / "${PLUGIN_DATA}"
    assert expand("${PLUGIN_ROOT}", sneaky, tmp_path / "data") == str(sneaky)


def test_command_is_never_expanded(roots: tuple[Path, Path]) -> None:
    """§9.2 exempts `command`: it stays the literal token it was written as.

    A placeholder there is therefore just an executable name that will not be
    found — a launch failure the manager reports, not a config rewrite.
    """
    _write(roots[0], {"a": {"type": "stdio", "command": "${PLUGIN_ROOT}"}})
    config = _load(roots).servers[0].config.config
    assert isinstance(config, MCPStdioConfig)
    assert config.command == "${PLUGIN_ROOT}"


def test_command_with_a_placeholder_path_is_skipped(roots: tuple[Path, Path]) -> None:
    """`${PLUGIN_ROOT}/bin/x` is neither a bare name nor a './' path."""
    _write(roots[0], {"a": {"type": "stdio", "command": "${PLUGIN_ROOT}/bin/x"}})
    result = _load(roots)
    assert result.servers == ()
    assert result.issues[0].target == "a"


# ── remote entries ───────────────────────────────────────────────────────


def test_streamable_http_is_translated(roots: tuple[Path, Path]) -> None:
    _write(
        roots[0],
        {
            "api": {
                "type": "streamable-http",
                "url": "https://deploy.example.com/mcp",
                "headers": {"X-Tenant": "public"},
            }
        },
    )
    server = _load(roots).servers[0]
    assert server.transport == "streamable-http"
    assert isinstance(server.config.config, MCPHttpConfig)
    assert server.config.config.headers == {"X-Tenant": "public"}


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/mcp",  # plain http, not loopback
        "https://user:pw@example.com/mcp",  # user information
        "https://example.com/mcp#frag",  # fragment
        "ftp://example.com/mcp",  # not http(s)
        "/mcp",  # not absolute
    ],
)
def test_invalid_urls_skip_the_entry(roots: tuple[Path, Path], url: str) -> None:
    _write(roots[0], {"api": {"type": "streamable-http", "url": url}})
    assert _load(roots).servers == ()


@pytest.mark.parametrize("url", ["http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://[::1]/mcp"])
def test_plain_http_is_allowed_on_loopback(roots: tuple[Path, Path], url: str) -> None:
    _write(roots[0], {"api": {"type": "streamable-http", "url": url}})
    assert len(_load(roots).servers) == 1


def test_headers_repeated_under_different_casing_are_invalid(roots: tuple[Path, Path]) -> None:
    _write(
        roots[0],
        {
            "api": {
                "type": "streamable-http",
                "url": "https://example.com/mcp",
                "headers": {"X-Tenant": "a", "x-tenant": "b"},
            }
        },
    )
    result = _load(roots)
    assert result.servers == ()
    assert "casing" in result.issues[0].message


def test_header_injection_is_rejected(roots: tuple[Path, Path]) -> None:
    _write(
        roots[0],
        {
            "api": {
                "type": "streamable-http",
                "url": "https://example.com/mcp",
                "headers": {"X-Tenant": "a\r\nX-Admin: 1"},
            }
        },
    )
    assert _load(roots).servers == ()


def test_legacy_sse_is_skipped_with_a_warning(roots: tuple[Path, Path]) -> None:
    _write(roots[0], {"old": {"type": "sse", "url": "https://example.com/sse"}})
    result = _load(roots)
    assert result.servers == ()
    assert [i.level for i in result.issues] == ["warning"]


# ── §7.2.2 failure isolation between entries ─────────────────────────────


def test_one_bad_entry_does_not_take_down_the_others(roots: tuple[Path, Path]) -> None:
    _write(
        roots[0],
        {
            "good": {"type": "stdio", "command": "npx"},
            "unknown-transport": {"type": "grpc", "url": "https://example.com"},
            "broken": {"type": "stdio"},
            "legacy": {"type": "sse", "url": "https://example.com/sse"},
            "remote": {"type": "streamable-http", "url": "https://example.com/mcp"},
        },
    )
    result = _load(roots)
    assert sorted(s.key for s in result.servers) == ["good", "remote"]
    assert {i.target for i in result.issues} == {"unknown-transport", "broken", "legacy"}


# ── derived ids ──────────────────────────────────────────────────────────


def test_server_ids_are_stable_unique_and_slug_shaped() -> None:
    from schemas.mcp import is_valid_server_id

    first = plugin_server_id("acme.tools", "validator")
    assert first == plugin_server_id("acme.tools", "validator")
    assert first != plugin_server_id("acme.tools", "other")
    assert first != plugin_server_id("acme-tools", "validator")
    for name, key in [("acme.tools", "validator"), ("a", "!!!"), ("x" * 64, "y" * 64)]:
        assert is_valid_server_id(plugin_server_id(name, key))
