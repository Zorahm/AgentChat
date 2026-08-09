"""Server mode — this backend is a shared host, not a desktop sidecar.

Switched on with ``AGENTCHAT_SERVER_MODE=1`` (see ``scripts/install-server.sh``).
It changes two things and nothing else:

* **The loopback exemption in the ``/api/*`` guard is off.** On a VDS the
  backend sits behind a reverse proxy, so every proxied request arrives from
  127.0.0.1. Keeping the exemption would hand an unauthenticated bypass to the
  whole internet, so in server mode the Bearer token is required of *everyone*.
* **The token comes from the environment** (or a 0600 file next to the data
  dir) instead of settings.json, and ``/api/remote-access`` stops serving it —
  there is no trusted local caller left to serve it to.

Everything else about a server-mode backend is identical to a desktop one; in
particular the agent's shell and file tools run here, on the server, which is
the whole point of the mode.

Leaf module: standard library plus ``paths`` (itself a leaf), so the guard, the
settings store and ``run.py`` can all import it without a cycle.
"""

from __future__ import annotations

import os
import secrets

from paths import AGENTS_DIR

_TRUTHY = {"1", "true", "yes", "on"}

MODE_ENV = "AGENTCHAT_SERVER_MODE"
TOKEN_ENV = "AGENTCHAT_REMOTE_TOKEN"
# Fallback home for a self-minted token. Lives in the data dir so a relocated
# AGENTCHAT_DATA_DIR (which every server install sets) keeps the secret with the
# rest of that install's state.
TOKEN_FILE = AGENTS_DIR / "server-token"

_file_token: str | None = None


def enabled() -> bool:
    """True when this process was started as a shared server.

    Read from the environment on every call rather than captured at import:
    a module constant would be copied into each ``from … import`` consumer,
    leaving the guard, the settings store and the tests disagreeing about the
    mode. The lookup is a dict hit — the guard can afford it per request.
    """
    return (os.environ.get(MODE_ENV) or "").strip().lower() in _TRUTHY


def _mint_token_file() -> str:
    """Generate a token and persist it with 0600 permissions."""
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Opened 0600 rather than written-then-chmod'ed: the latter leaves the
    # secret world-readable for the moment in between.
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fp:
        fp.write(token)
    return token


def server_token() -> str:
    """The shared secret every client must present in server mode.

    ``AGENTCHAT_REMOTE_TOKEN`` wins — that is what the installer sets. Failing
    that a token is read from, or minted into, ``TOKEN_FILE``, so a
    hand-started backend is never left with no secret at all. Only the file
    lookup is memoized; the guard calls this on every request.
    """
    env = (os.environ.get(TOKEN_ENV) or "").strip()
    if env:
        return env
    global _file_token
    if not _file_token:
        try:
            _file_token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            _file_token = ""
        if not _file_token:
            _file_token = _mint_token_file()
    return _file_token


def token_origin() -> str:
    """Where ``server_token()`` read the secret from — for the startup banner.

    Returns a description, never the secret itself: the banner goes to the
    journal, which outlives the terminal it was printed to.
    """
    if (os.environ.get(TOKEN_ENV) or "").strip():
        return f"${TOKEN_ENV}"
    return str(TOKEN_FILE)
