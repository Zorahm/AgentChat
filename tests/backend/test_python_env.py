"""Tests for chat-local Python environment shell helpers."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.python_env import bash_python_env_prelude


def test_bash_python_env_prelude_routes_pip_to_chat_venv() -> None:
    prelude = bash_python_env_prelude()

    assert 'export VIRTUAL_ENV="$PWD/.venv"' in prelude
    assert 'export PATH="$VIRTUAL_ENV/bin:$PATH"' in prelude
    assert 'python3 -m venv "$VIRTUAL_ENV"' in prelude
    assert '[ "$arg" = "--user" ] && continue' in prelude
    assert "pip() {" in prelude
    assert "pip3() {" in prelude
