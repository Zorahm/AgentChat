"""Shared test fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture
def sample_config() -> dict[str, str]:
    return {"model": "test-model", "api_key": "sk-test"}

# pytest configuration for async tests
pytest_plugins = ("pytest_asyncio",)
