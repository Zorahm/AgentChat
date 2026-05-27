"""Remote (phone) access pairing endpoint.

Exposes the Bearer token and reachable URLs needed to connect a phone to this
backend. Guarded to loopback only — the token must never be served to a remote
caller, even one that already holds it.
"""

from __future__ import annotations

import os
import socket

from fastapi import APIRouter, HTTPException, Request

from api.schemas.settings import RemoteAccessInfo

router = APIRouter(tags=["remote"])


def _backend_port() -> int:
    raw = os.environ.get("AGENTCHAT_PORT", "8787")
    try:
        return int(raw)
    except ValueError:
        return 8787


def _local_ipv4s() -> list[str]:
    """Best-effort enumeration of this machine's non-loopback IPv4 addresses.

    Combines the default-route address (the usual LAN IP) with whatever the
    hostname resolves to — the latter often surfaces extra adapters such as
    Tailscale (100.x). Detection is inherently incomplete; the UI also lets the
    user type a Tailscale MagicDNS name by hand.
    """
    ips: set[str] = set()

    # Primary outbound interface — no packets are actually sent.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ips.add(sock.getsockname()[0])
    except OSError:
        pass
    finally:
        sock.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass

    return sorted(ip for ip in ips if not ip.startswith("127."))


def _is_loopback(request: Request) -> bool:
    client = request.client
    host = client.host if client else ""
    return host in {"127.0.0.1", "::1", "localhost"}


@router.get("/remote-access", response_model=RemoteAccessInfo)
async def remote_access(request: Request) -> RemoteAccessInfo:
    """Return pairing info (token + URLs). Loopback only."""
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="Pairing info is available locally only.")

    store = request.app.state.settings_store
    port = _backend_port()
    urls = [f"http://{ip}:{port}" for ip in _local_ipv4s()]
    return RemoteAccessInfo(
        enabled=store.remote_access_enabled,
        token=store.remote_token,
        port=port,
        urls=urls,
    )
