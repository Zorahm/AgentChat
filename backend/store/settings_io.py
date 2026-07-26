"""settings.json I/O and the secret boundary.

Owns the on-disk shape: safe parse, atomic write, and the split that keeps
secrets in the :class:`SecretStore` rather than in the JSON file.
:class:`~store.settings_store.SettingsStore` keeps the state and the validation
policy; this module keeps the file format.

The pairing to hold in mind: :func:`split_secrets` runs on every save and
:func:`merge_secrets` on every load, so the in-memory settings look exactly the
same whether a secret came from the keychain or from a pre-migration file.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from mcp_integration.config import MCP_SECRET_FIELDS
from store.secret_store import SecretStore

# settings.json field under "global" → SecretStore name.
_GLOBAL_SECRETS: dict[str, str] = {
    "tavily_api_key": "tavily",
    "remote_token": "remote_token",
}


# ---------------------------------------------------------------------------
# file I/O
# ---------------------------------------------------------------------------


def read_settings_file(path: Path | None) -> dict[str, Any]:
    """Parse settings.json.

    A missing file is first run. A corrupt one is logged and treated as empty —
    losing preferences beats refusing to start.
    """
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[settings] failed to load {path}: {exc}")
        return {}
    return data if isinstance(data, dict) else {}


def write_settings_file(path: Path | None, payload: dict[str, Any]) -> None:
    """Atomically replace settings.json (tmp sibling + rename)."""
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=".settings-", suffix=".json.tmp", dir=path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError as exc:
        print(f"[settings] failed to save {path}: {exc}")


# ---------------------------------------------------------------------------
# secret split / merge
# ---------------------------------------------------------------------------


def split_secrets(payload: dict[str, Any], secrets: SecretStore) -> dict[str, Any]:
    """Move every secret in *payload* into *secrets*; return a sanitized copy.

    A delete is emitted for the secrets of every provider and MCP server the
    payload mentions, so clearing a key in the UI clears it in the keychain
    too. Providers and servers removed outright are handled by SettingsStore —
    it is the only layer that knows an id disappeared.
    """
    out = copy.deepcopy(payload)

    global_block = out.get("global")
    if isinstance(global_block, dict):
        for field, name in _GLOBAL_SECRETS.items():
            value = global_block.get(field)
            secrets.set(name, value if isinstance(value, str) else None)
            global_block[field] = None

    for raw_p in _iter_dicts(out.get("providers")):
        pid = raw_p.get("id")
        if not isinstance(pid, str):
            continue
        blob: dict[str, Any] = {}
        if raw_p.get("api_key"):
            blob["api_key"] = raw_p["api_key"]
        if raw_p.get("extra_headers"):
            blob["extra_headers"] = raw_p["extra_headers"]
        secrets.set(f"provider:{pid}", json.dumps(blob) if blob else None)
        raw_p["api_key"] = None
        raw_p["extra_headers"] = None

    for raw_s in _iter_mcp_servers(out):
        sid = raw_s.get("id")
        cfg = raw_s.get("config")
        if not isinstance(sid, str) or not isinstance(cfg, dict):
            continue
        blob = {}
        for field in MCP_SECRET_FIELDS:
            value = cfg.get(field)
            if isinstance(value, dict) and value:
                blob[field] = value
                cfg[field] = {}
        secrets.set(f"mcp:{sid}", json.dumps(blob) if blob else None)

    return out


def merge_secrets(
    payload: dict[str, Any], secrets: SecretStore
) -> tuple[dict[str, Any], bool]:
    """Rehydrate secrets into *payload*; return it plus whether migration is due.

    A secret still sitting inline in settings.json means a pre-migration file:
    it is used as-is so nothing breaks on upgrade, and the returned flag tells
    SettingsStore to re-save — which writes it to the SecretStore and strips it
    from the JSON. Stored secrets win over inline ones, so a half-migrated file
    can never resurrect a key the user has since replaced.
    """
    out = copy.deepcopy(payload)
    migrate = False

    global_block = out.get("global")
    if isinstance(global_block, dict):
        for field, name in _GLOBAL_SECRETS.items():
            stored = secrets.get(name)
            if stored is not None:
                global_block[field] = stored
            elif global_block.get(field):
                migrate = True

    for raw_p in _iter_dicts(out.get("providers")):
        pid = raw_p.get("id")
        if not isinstance(pid, str):
            continue
        stored_blob = _json_object(secrets.get(f"provider:{pid}"))
        for field in ("api_key", "extra_headers"):
            if field in stored_blob:
                raw_p[field] = stored_blob[field]
            elif raw_p.get(field):
                migrate = True

    for raw_s in _iter_mcp_servers(out):
        sid = raw_s.get("id")
        cfg = raw_s.get("config")
        if not isinstance(sid, str) or not isinstance(cfg, dict):
            continue
        stored_blob = _json_object(secrets.get(f"mcp:{sid}"))
        for field in MCP_SECRET_FIELDS:
            if field in stored_blob:
                cfg[field] = stored_blob[field]
            elif cfg.get(field):
                migrate = True

    return out, migrate


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _iter_dicts(value: Any) -> list[dict[str, Any]]:
    """Every dict in *value* when it is a list, else nothing."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _iter_mcp_servers(payload: dict[str, Any]) -> list[dict[str, Any]]:
    mcp_block = payload.get("mcp")
    if not isinstance(mcp_block, dict):
        return []
    return _iter_dicts(mcp_block.get("servers"))


def _json_object(raw: str | None) -> dict[str, Any]:
    """Decode a stored secret blob, tolerating anything unexpected."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}
