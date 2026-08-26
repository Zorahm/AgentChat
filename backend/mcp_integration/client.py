"""Low-level helpers that open an MCP ``ClientSession``.

The functions here translate :class:`MCPServerConfig` into the right SDK
constructor and return an :class:`contextlib.AsyncExitStack` that owns the
underlying connection. Callers keep the stack alive for as long as they
want the session, then ``await stack.aclose()`` to tear it down.
"""

from __future__ import annotations

import os
import shutil
from contextlib import AsyncExitStack
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mcp import ClientSession

from schemas.mcp import MCPHttpConfig, MCPServerConfig, MCPStdioConfig

# Env vars a child MCP server legitimately needs: locate its binaries, resolve
# HOME, reach the network, trust the system cert store. Deliberately NOT the
# whole of ``os.environ`` — this backend's own environment holds provider
# secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, TAVILY_API_KEY, …) and handing
# them to a third-party subprocess leaks every one of them. That is the same
# threat the bash sandbox spends ``--clearenv`` on. A server that needs a
# secret declares it explicitly in ``cfg.env``.
#
# ``os.environ`` is case-insensitive on Windows, so the mixed-case Windows
# names below resolve there and are simply absent on POSIX.
_ENV_PASSTHROUGH: tuple[str, ...] = (
    # POSIX basics
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR",
    # Windows basics
    "SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA",
    "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP",
    # Toolchain lookup paths
    "NODE_PATH", "NVM_DIR", "NVM_BIN", "PYTHONHOME", "PYTHONPATH",
    # TLS trust + proxies
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
)


def _passthrough_env() -> dict[str, str]:
    """Copy only the allow-listed vars out of the backend's environment."""
    return {
        name: value
        for name in _ENV_PASSTHROUGH
        if (value := os.environ.get(name)) is not None
    }


def _build_stdio_params(cfg: MCPStdioConfig) -> tuple[str, list[str], dict[str, str]]:
    """Return ``(command, args, env)`` ready for ``StdioServerParameters``.

    When ``runtime == "wsl"`` the original command is wrapped in
    ``wsl.exe -- bash -lc '<quoted script>'``. Env vars are forwarded via
    ``A=1 B=2`` prefixes inside the inner script so they survive the WSL
    boundary (the outer ``env=`` dict only mutates the Windows child).
    """
    base_env = {**_passthrough_env(), **cfg.env}

    if cfg.runtime == "host":
        return cfg.command, list(cfg.args), base_env

    # runtime == "wsl"
    wsl = shutil.which("wsl") or "wsl.exe"
    inner_parts: list[str] = []
    for key, value in cfg.env.items():
        inner_parts.append(f"{key}={_sh_quote(value)}")
    inner_parts.append(_sh_quote(cfg.command))
    inner_parts.extend(_sh_quote(a) for a in cfg.args)
    inner_script = " ".join(inner_parts)
    return wsl, ["--", "bash", "-lc", inner_script], base_env


def _sh_quote(value: str) -> str:
    """Minimal single-quote shell quoting safe for bash -lc."""
    if not value:
        return "''"
    if all(c.isalnum() or c in "@%+=:,./-_" for c in value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


async def open_session(
    cfg: MCPServerConfig,
    stack: AsyncExitStack,
) -> ClientSession:
    """Open an MCP session for ``cfg`` and tie its lifetime to ``stack``.

    The caller owns ``stack``; closing it tears down the subprocess or HTTP
    connection. Returns a fully-initialised :class:`ClientSession`.
    """
    # Imported lazily so the rest of the module imports cleanly even when
    # the optional ``mcp`` dependency is missing — surfacing a clearer
    # error only at the point where someone actually tries to connect.
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp.client.streamable_http import streamablehttp_client

    transport = cfg.config

    if isinstance(transport, MCPStdioConfig):
        command, args, env = _build_stdio_params(transport)
        # Only the host runtime honours ``cwd``: the WSL branch runs the real
        # command inside ``bash -lc``, where a Windows-side working directory
        # means nothing. Agent Plugins servers are always host-run, so the
        # spec's "default to the plugin root" lands here.
        cwd = transport.cwd if transport.runtime == "host" else None
        params = StdioServerParameters(command=command, args=args, env=env, cwd=cwd)
        read_stream, write_stream = await stack.enter_async_context(stdio_client(params))
    elif isinstance(transport, MCPHttpConfig):
        result = await stack.enter_async_context(
            streamablehttp_client(transport.url, headers=transport.headers or None)
        )
        # streamablehttp_client yields (read, write, session_id_callback)
        read_stream, write_stream = result[0], result[1]
    else:  # pragma: no cover — discriminator keeps this unreachable
        raise ValueError(f"Unsupported transport: {transport!r}")

    session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
    await session.initialize()
    return session
