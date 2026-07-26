"""Session-wide isolation of the app's data directory.

``test_remote_access`` imports ``main``, which builds the entire FastAPI app at
module scope against whatever ``paths`` resolved when it was imported. Without
this override a plain ``pytest`` run reads and REWRITES the developer's real
settings.json, databases and OS keychain entries — which is exactly what
happened once. The variable has to be set before any backend module is
imported, so it lives here rather than in a fixture.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Iterator

import pytest

_OWNED_DIR: str | None = None

if "AGENTCHAT_DATA_DIR" not in os.environ:
    _OWNED_DIR = tempfile.mkdtemp(prefix="agentchat-tests-")
    os.environ["AGENTCHAT_DATA_DIR"] = _OWNED_DIR


@pytest.fixture(scope="session", autouse=True)
def _cleanup_data_dir() -> Iterator[None]:
    yield
    if _OWNED_DIR:
        shutil.rmtree(_OWNED_DIR, ignore_errors=True)
