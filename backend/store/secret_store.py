"""Named secret storage — OS keychain first, restricted-permission file fallback.

Knows nothing about providers, MCP servers, or settings: callers hand over a
name and a string, and JSON-encode anything structured themselves. Keeping the
value opaque is what lets the storage backend change without touching callers.

Threat model, stated plainly: the keychain protects secrets from other user
accounts and from anything that merely reads files (including the model's own
shell, which can no longer find keys by opening settings.json). It does *not*
protect against a process running as the same user that deliberately calls the
platform credential API. The file fallback is weaker still — 0600 permissions,
no encryption — and exists only so headless hosts keep working.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Literal

SecretBackend = Literal["keyring", "file", "memory"]

# Every AgentChat secret lives under one keychain service; the secret's own
# name is the keychain "username".
_SERVICE = "AgentChat"
_PROBE_NAME = "__agentchat_probe__"


def _select_keyring() -> Any | None:
    """Return a verified platform keyring backend, or ``None``.

    The backend class is named EXPLICITLY instead of going through
    ``keyring.get_keyring()``. Autodiscovery reads entry-point metadata, which
    PyInstaller does not bundle: the frozen sidecar would silently resolve to
    ``fail.Keyring`` and raise on the first write while a source checkout
    worked fine — the kind of divergence that only surfaces in a release build.
    """
    try:
        if sys.platform == "win32":
            from keyring.backends import Windows

            backend: Any = Windows.WinVaultKeyring()
        elif sys.platform == "darwin":
            from keyring.backends import macOS

            backend = macOS.Keyring()
        else:
            from keyring.backends import SecretService

            backend = SecretService.Keyring()
    except Exception as exc:  # noqa: BLE001 — package missing or platform backend unusable
        print(f"[secrets] no keychain backend available ({exc}); falling back to file storage")
        return None

    # A backend can import cleanly and still be dead at runtime — headless Linux
    # with no D-Bus session is the common case — so prove it round-trips before
    # trusting it with real secrets.
    try:
        backend.set_password(_SERVICE, _PROBE_NAME, "1")
        ok = backend.get_password(_SERVICE, _PROBE_NAME) == "1"
        backend.delete_password(_SERVICE, _PROBE_NAME)
    except Exception as exc:  # noqa: BLE001
        print(f"[secrets] keychain backend not usable ({exc}); falling back to file storage")
        return None
    if not ok:
        print("[secrets] keychain backend failed its round-trip probe; falling back to file")
        return None
    return backend


class SecretStore:
    """Read and write named secrets.

    ``use_keyring`` defaults to False so tests and embedders never write into
    the developer's real OS keychain; the app's composition root
    (``main.create_app``) is the one caller that opts in.
    """

    def __init__(self, file_path: Path | None, *, use_keyring: bool = False) -> None:
        self._file_path = file_path
        self._keyring = _select_keyring() if use_keyring else None
        self._cache: dict[str, str] = {}
        if self._keyring is not None:
            if file_path is not None and file_path.is_file():
                self._absorb_file()
        elif file_path is not None:
            self._cache = self._read_file()
            print(
                f"[secrets] using unencrypted file storage at {file_path} "
                "(no OS keychain available)"
            )

    @property
    def backend(self) -> SecretBackend:
        if self._keyring is not None:
            return "keyring"
        return "file" if self._file_path is not None else "memory"

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def get(self, name: str) -> str | None:
        if self._keyring is not None:
            try:
                value = self._keyring.get_password(_SERVICE, name)
            except Exception as exc:  # noqa: BLE001
                print(f"[secrets] failed to read {name!r} from the keychain: {exc}")
                return None
            return value if isinstance(value, str) else None
        return self._cache.get(name)

    def set(self, name: str, value: str | None) -> None:
        """Store *value* under *name*. ``None`` or empty removes the entry."""
        if self._keyring is not None:
            try:
                if value:
                    self._keyring.set_password(_SERVICE, name, value)
                elif self._keyring.get_password(_SERVICE, name) is not None:
                    # Deleting an absent entry raises on most backends, and this
                    # runs on every save for every unset key — check first so a
                    # normal save stays quiet.
                    self._keyring.delete_password(_SERVICE, name)
            except Exception as exc:  # noqa: BLE001
                print(f"[secrets] failed to write {name!r} to the keychain: {exc}")
            return
        if value:
            self._cache[name] = value
        else:
            self._cache.pop(name, None)
        self._write_file()

    # ------------------------------------------------------------------
    # file backend
    # ------------------------------------------------------------------

    def _absorb_file(self) -> None:
        """Move file-backend leftovers into the keychain, then delete the file.

        Runs when a machine gains a working keychain after having used the
        fallback (a Linux box that grew a D-Bus session, or an upgrade).
        Existing keychain entries win — the file is the stale copy — and it is
        removed afterwards so no plaintext is left behind.
        """
        leftovers = self._read_file()
        for name, value in leftovers.items():
            if value and self.get(name) is None:
                self.set(name, value)
        if self._file_path is None:
            return
        try:
            self._file_path.unlink()
        except OSError as exc:
            print(f"[secrets] could not remove plaintext fallback {self._file_path}: {exc}")

    def _read_file(self) -> dict[str, str]:
        path = self._file_path
        if path is None or not path.is_file():
            return {}
        try:
            data = json.loads(path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[secrets] failed to load {path}: {exc}")
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(k): v for k, v in data.items() if isinstance(v, str)}

    def _write_file(self) -> None:
        path = self._file_path
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Same tmp-sibling + atomic rename dance as settings.json, so a
            # crash mid-write can never leave a truncated secret file.
            fd, tmp_path = tempfile.mkstemp(
                prefix=".secrets-", suffix=".json.tmp", dir=path.parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(self._cache, f, indent=2, ensure_ascii=False)
                # mkstemp already creates 0600; restate it so confidentiality
                # doesn't rest on an implementation detail. On Windows chmod
                # only toggles the read-only bit — the file backend is not
                # expected there, since the Credential Manager always works.
                os.chmod(tmp_path, 0o600)
                os.replace(tmp_path, path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except OSError as exc:
            print(f"[secrets] failed to save {path}: {exc}")
