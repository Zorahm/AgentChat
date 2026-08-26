"""Manifest loading and validation — Agent Plugins §5.

The awkward part of §5 is that its schema is closed but two of its violations
are explicitly *non-fatal*: an unknown top-level field and a non-object
``extensions``. Both must be reported and ignored, and the plugin must keep
loading. Everything else is fatal — the client rejects the plugin and refuses
to discover or execute any of its components.

That asymmetry is why validation lives here rather than in the Pydantic model:
a model can ignore an unknown field or reject it, but it cannot hand back
"ignored, and here is what I ignored".
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from schemas.plugins import (
    MANIFEST_FILE_NAME,
    MANIFEST_FIELDS,
    SUPPORTED_PLUGIN_SCHEMAS,
    PluginIssue,
    PluginManifest,
    is_valid_plugin_name,
)


@dataclass(frozen=True)
class ManifestResult:
    """Outcome of reading one ``plugin.json``.

    ``manifest is None`` means the plugin is rejected: no component of it may
    be discovered or executed. Issues are returned either way — a rejected
    plugin still gets listed in the UI with its reason.
    """

    manifest: PluginManifest | None
    issues: tuple[PluginIssue, ...] = field(default=())

    @property
    def rejected(self) -> bool:
        return self.manifest is None


def _error(message: str, target: str | None = None) -> PluginIssue:
    return PluginIssue(level="error", scope="manifest", message=message, target=target)


def _warning(message: str, target: str | None = None) -> PluginIssue:
    return PluginIssue(level="warning", scope="manifest", message=message, target=target)


def load_manifest(plugin_root: Path) -> ManifestResult:
    """Read and validate ``<plugin_root>/plugin.json``."""
    path = plugin_root / MANIFEST_FILE_NAME
    if not path.is_file():
        return ManifestResult(None, (_error(f"No {MANIFEST_FILE_NAME} in the plugin root"),))
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        return ManifestResult(None, (_error(f"Cannot read {MANIFEST_FILE_NAME}: {exc}"),))
    except json.JSONDecodeError as exc:
        return ManifestResult(None, (_error(f"{MANIFEST_FILE_NAME} is not valid JSON: {exc}"),))
    return parse_manifest(raw)


def parse_manifest(raw: Any) -> ManifestResult:
    """Validate an already-decoded manifest document.

    Kept separate from the file read so the §5 rules can be exercised without
    touching a filesystem.
    """
    if not isinstance(raw, dict):
        return ManifestResult(None, (_error(f"{MANIFEST_FILE_NAME} must contain a JSON object"),))

    issues: list[PluginIssue] = []
    document: dict[str, Any] = dict(raw)

    # §5.2 — unknown top-level fields are reported and dropped. Dropping them
    # before validation is what stops a client from quietly assigning them
    # meaning later.
    for key in sorted(set(document) - MANIFEST_FIELDS):
        issues.append(_warning(f"Unknown manifest field ignored: {key!r}", target=key))
        document.pop(key, None)

    # §8.1 — a non-object `extensions` is the second non-fatal violation. A
    # *member* whose value is not an object is not covered by that exception,
    # so it stays fatal (the published JSON Schema types every member as an
    # object) and falls through to Pydantic below.
    if "extensions" in document and not isinstance(document["extensions"], dict):
        issues.append(_warning("Non-object 'extensions' ignored", target="extensions"))
        document.pop("extensions")

    schema_id = document.get("$schema")
    if not isinstance(schema_id, str) or not schema_id:
        issues.append(_error("Missing required '$schema'", target="$schema"))
        return ManifestResult(None, tuple(issues))
    if schema_id not in SUPPORTED_PLUGIN_SCHEMAS:
        # Offline selection: an unrecognised identifier is an Agent Plugins
        # version we do not implement, and the spec forbids fetching it to
        # find out.
        issues.append(
            _error(f"Unsupported Agent Plugins manifest schema: {schema_id}", target="$schema")
        )
        return ManifestResult(None, tuple(issues))

    name = document.get("name")
    if not isinstance(name, str) or not name:
        issues.append(_error("Missing required 'name'", target="name"))
        return ManifestResult(None, tuple(issues))
    if not is_valid_plugin_name(name):
        issues.append(
            _error(
                f"Invalid plugin name {name!r}: 1-64 chars of a-z, 0-9, '-' and '.', "
                "alphanumeric at both ends, no '--' or '..'",
                target="name",
            )
        )
        return ManifestResult(None, tuple(issues))

    try:
        manifest = PluginManifest.model_validate(document)
    except ValidationError as exc:
        for err in exc.errors():
            location = ".".join(str(p) for p in err["loc"]) or None
            issues.append(_error(err["msg"], target=location))
        return ManifestResult(None, tuple(issues))

    return ManifestResult(manifest, tuple(issues))
