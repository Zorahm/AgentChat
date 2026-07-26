"""Is this request from the local machine?

Leaf module — imports only the standard library and starlette's Request type.
It exists so both the remote-access middleware (``main``) and the pairing
endpoint (``api.remote``) answer the question the same way: they used to carry
two implementations, and the weaker one accepted only the literal loopback
names, letting an address like ``127.0.0.2`` fall through as remote.
"""

from __future__ import annotations

import ipaddress

from fastapi import Request

_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def is_loopback_request(request: Request) -> bool:
    """True when the request originates from this machine (the desktop app).

    Loopback clients are exempt from remote-access token checks; everything
    else (LAN / Tailscale / phone) must present the Bearer token.
    """
    client = request.client
    if client is None:
        return False
    host = client.host or ""
    if host in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
