"""Guards the backend's import layering against circular-import regressions.

Every check here runs in a FRESH interpreter. Inside a single pytest process the
modules are already in ``sys.modules``, so an import cycle is invisible — which
is precisely how this class of bug stayed latent: every test happened to import
an ``api.*`` symbol first, and that order was the only reason the graph
resolved.

The layering rule these tests encode: ``schemas`` is a leaf holding the Pydantic
contracts, and the lower layers (``store``, ``llm``, ``mcp_integration``,
``research``) import *down* into it. Nothing below the route handlers may reach
up into ``api``.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"

# Modules that a cycle would break. Each one must import as the very first
# backend module in a virgin interpreter.
STANDALONE_MODULES = [
    "schemas.settings",
    "schemas.agents",
    "schemas.redaction",
    "schemas.chat",
    "schemas.mcp",
    "schemas.skills",
    "schemas.memory",
    "store.settings_store",
    "store.settings_io",
    "store.memory_store",
    "tools.memory_tools",
    "llm.model_tag",
    "llm.models_fetcher",
    "mcp_integration.registry_view",
    "mcp_integration.manager",
    "research.toolset",
    "research.lead",
    "tools.factory",
    "api.router",
    "api.settings",
    "api.chat",
    "main",
]


def _run_in_fresh_interpreter(code: str) -> subprocess.CompletedProcess[str]:
    """Execute *code* with ``backend/`` on ``sys.path`` and nothing preloaded."""
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(BACKEND_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )


@pytest.mark.parametrize("module", STANDALONE_MODULES)
def test_module_imports_standalone(module: str) -> None:
    """No module needs a bootstrap import to become importable."""
    result = _run_in_fresh_interpreter(f"import {module}")
    assert result.returncode == 0, (
        f"`import {module}` failed as a first import:\n{result.stderr}"
    )


def test_api_package_does_not_pull_the_router() -> None:
    """``import api`` must stay cheap.

    An eager ``from api.router import api_router`` in ``api/__init__.py`` drags
    every route module — and therefore the whole app graph — into any import
    that merely touches an ``api.*`` name. That is what made the cycle
    reachable, so the emptiness of this package's ``__init__`` is load-bearing.
    """
    result = _run_in_fresh_interpreter(
        "import api, sys; "
        "assert 'api.router' not in sys.modules, 'api/__init__.py imports the router'"
    )
    assert result.returncode == 0, result.stderr


def test_schemas_package_stays_a_leaf() -> None:
    """Importing the contracts must not drag in a single app layer.

    ``schemas`` sits at the bottom of the graph. Enforced by inspecting
    ``sys.modules`` after importing every submodule, which catches an indirect
    pull as well as a direct one — the MCP models used to live in
    ``mcp_integration``, so defining a settings contract imported the process
    supervisor, asyncio and ssl behind it.
    """
    app_packages = {
        "api",
        "store",
        "agent",
        "llm",
        "mcp_integration",
        "research",
        "tools",
        "web_search",
        "skills",
        "main",
    }
    result = _run_in_fresh_interpreter(
        "import schemas.settings, schemas.agents, schemas.chat, schemas.mcp, "
        "schemas.skills, schemas.redaction, schemas.memory, sys\n"
        f"app = {app_packages!r}\n"
        "leaked = sorted(m for m in sys.modules if m.split('.')[0] in app)\n"
        "assert not leaked, f'schemas pulled app layers: {leaked}'"
    )
    assert result.returncode == 0, result.stderr
