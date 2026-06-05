"""Remote (phone) access pairing endpoint.

Exposes the Bearer token and reachable URLs needed to connect a phone to this
backend. Guarded to loopback only — the token must never be served to a remote
caller, even one that already holds it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import shutil
import socket
import subprocess

from fastapi import APIRouter, HTTPException, Request

from api.schemas.settings import RemoteAccessInfo

router = APIRouter(tags=["remote"])

# Suppress the console-window flash when spawning the Tailscale CLI on Windows.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Tailscale (and other CGNAT-based mesh VPNs) hand out addresses from
# 100.64.0.0/10. A phone joined to the tailnet can reach this address but NOT
# the host's plain-LAN IPs, so we surface it first as the default pairing URL.
_TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")


def _is_tailscale_ip(ip: str) -> bool:
    """True iff ``ip`` is in the 100.64.0.0/10 range Tailscale assigns."""
    try:
        return ipaddress.ip_address(ip) in _TAILSCALE_NET
    except ValueError:
        return False


def _tailscale_ipv4() -> str | None:
    """The authoritative tailnet IPv4 for THIS device, via the Tailscale CLI.

    A host can surface more than one 100.64.0.0/10 address (e.g. a stale lease
    left in ``getaddrinfo``), and the CGNAT-range heuristic alone can't tell
    which one is actually live. ``tailscale ip -4`` reports the single address
    Tailscale is currently using, so when available it wins the default slot.
    Returns None if the CLI is missing or Tailscale isn't running.
    """
    exe = shutil.which("tailscale")
    if not exe and os.name == "nt":
        candidate = os.path.join(
            os.environ.get("ProgramFiles", r"C:\\Program Files"), "Tailscale", "tailscale.exe"
        )
        if os.path.exists(candidate):
            exe = candidate
    if not exe:
        return None
    try:
        result = subprocess.run(
            [exe, "ip", "-4"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        ip = line.strip()
        if _is_tailscale_ip(ip):
            return ip
    return None


def _sort_ips(ips: list[str], primary: str | None = None) -> list[str]:
    """Order addresses with the live Tailscale address first.

    Ordering: the CLI-confirmed ``primary`` tailnet IP, then any other
    Tailscale-range (100.64.0.0/10) address, then everything else
    lexicographically. The first entry becomes the default QR/URL in the UI, so
    a phone paired over Tailscale connects on the first try instead of scanning
    a LAN IP — or a stale 100.x — it can't route to.
    """
    return sorted(ips, key=lambda ip: (ip != primary, not _is_tailscale_ip(ip), ip))


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

    # Ground-truth tailnet address (may be missing from the probes above).
    primary = _tailscale_ipv4()
    if primary:
        ips.add(primary)

    candidates = [ip for ip in ips if not ip.startswith("127.")]
    if primary:
        # The CLI told us the one live tailnet IP — drop any other 100.x leases
        # (stale getaddrinfo entries) so the user isn't offered a dead address.
        # Plain-LAN IPs stay: still useful when the phone is on the same Wi-Fi.
        candidates = [ip for ip in candidates if ip == primary or not _is_tailscale_ip(ip)]

    return _sort_ips(candidates, primary=primary)


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
    ips = await asyncio.to_thread(_local_ipv4s)
    urls = [f"http://{ip}:{port}" for ip in ips]
    return RemoteAccessInfo(
        enabled=store.remote_access_enabled,
        token=store.remote_token,
        port=port,
        urls=urls,
    )
