"""Agent Plugins §5 — the manifest.

Mirrors the "Plugin loader" block of the spec's conformance checklist. The
distinction these tests exist to protect: exactly two schema violations are
non-fatal (an unknown top-level field, a non-object ``extensions``), and every
other one rejects the whole plugin.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from plugins.manifest import load_manifest, parse_manifest
from schemas.plugins import PLUGIN_SCHEMA_1_0_0, is_valid_plugin_name

VALID = {"$schema": PLUGIN_SCHEMA_1_0_0, "name": "my-plugin"}


def _levels(result, level: str) -> list[str]:
    return [i.message for i in result.issues if i.level == level]


# ── the happy path ───────────────────────────────────────────────────────


def test_minimal_manifest_needs_only_schema_and_name() -> None:
    result = parse_manifest(VALID)
    assert result.manifest is not None
    assert result.manifest.name == "my-plugin"
    assert result.issues == ()


def test_metadata_is_typed_but_not_interpreted() -> None:
    """§5.4 forbids rejecting a manifest for non-semver, non-SPDX or non-URL values."""
    result = parse_manifest(
        {
            **VALID,
            "version": "banana",
            "license": "whatever-license",
            "homepage": "not a url",
            "repository": "also not a url",
            "author": {"name": "Ada", "email": "not an email", "url": "nope"},
            "keywords": ["a", "b"],
        }
    )
    assert result.manifest is not None
    assert result.manifest.version == "banana"
    assert result.manifest.author is not None
    assert result.manifest.author.name == "Ada"


def test_extensions_namespaces_are_kept_unvalidated() -> None:
    result = parse_manifest(
        {**VALID, "extensions": {"com.example.client": {"anything": [1, 2, 3]}}}
    )
    assert result.manifest is not None
    assert result.manifest.extensions == {"com.example.client": {"anything": [1, 2, 3]}}


# ── the two non-fatal violations ─────────────────────────────────────────


def test_unknown_top_level_field_is_reported_and_ignored() -> None:
    result = parse_manifest({**VALID, "commands": ["./do-a-thing"]})
    assert result.manifest is not None, "an unknown field must not reject the plugin"
    assert _levels(result, "warning")
    assert not hasattr(result.manifest, "commands")


def test_non_object_extensions_is_reported_and_ignored() -> None:
    result = parse_manifest({**VALID, "extensions": ["com.example.client"]})
    assert result.manifest is not None
    assert result.manifest.extensions is None
    assert any("extensions" in m for m in _levels(result, "warning"))


# ── fatal violations ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "document",
    [
        pytest.param({"name": "my-plugin"}, id="no-schema"),
        pytest.param({"$schema": "https://example.com/other.json", "name": "x"}, id="alien-schema"),
        pytest.param({"$schema": PLUGIN_SCHEMA_1_0_0}, id="no-name"),
        pytest.param({**VALID, "version": 1.0}, id="version-not-a-string"),
        pytest.param({**VALID, "keywords": "a,b"}, id="keywords-not-a-list"),
        pytest.param({**VALID, "author": {"name": "Ada", "twitter": "@ada"}}, id="author-extra"),
        pytest.param({**VALID, "author": "Ada"}, id="author-not-an-object"),
        pytest.param({**VALID, "extensions": {"com.example": 42}}, id="extension-not-an-object"),
    ],
)
def test_fatal_violations_reject_the_plugin(document: dict) -> None:
    result = parse_manifest(document)
    assert result.rejected
    assert _levels(result, "error")


def test_a_non_object_document_is_rejected() -> None:
    assert parse_manifest([1, 2, 3]).rejected


# ── §5.5 name constraints ────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["my-plugin", "acme.tools", "lint3r", "a", "a" * 64])
def test_valid_names(name: str) -> None:
    assert is_valid_plugin_name(name)
    assert parse_manifest({**VALID, "name": name}).manifest is not None


@pytest.mark.parametrize(
    "name",
    ["My-Plugin", "-start", "end-", "has--double", "too.many..dots", "", "a" * 65, "under_score"],
)
def test_invalid_names(name: str) -> None:
    assert not is_valid_plugin_name(name)
    assert parse_manifest({**VALID, "name": name}).rejected


# ── reading from disk ────────────────────────────────────────────────────


def test_missing_manifest_rejects(tmp_path: Path) -> None:
    result = load_manifest(tmp_path)
    assert result.rejected
    assert "plugin.json" in result.issues[0].message


def test_malformed_json_rejects(tmp_path: Path) -> None:
    (tmp_path / "plugin.json").write_text("{ not json", encoding="utf-8")
    result = load_manifest(tmp_path)
    assert result.rejected
    assert "valid JSON" in result.issues[0].message


def test_load_from_disk(tmp_path: Path) -> None:
    (tmp_path / "plugin.json").write_text(json.dumps(VALID), encoding="utf-8")
    result = load_manifest(tmp_path)
    assert result.manifest is not None
    assert result.manifest.name == "my-plugin"
