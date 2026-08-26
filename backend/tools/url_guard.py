"""Which hosts ``web_fetch`` is allowed to reach.

``web_fetch`` is the one tool whose target can be *named by the content it just
read*: a search result or a fetched page can say "now open this URL", and the
model may oblige. That makes it the natural way for text the user never wrote to
reach a service that trusts whoever can connect to it.

Two categories, because they are not equally dangerous:

**Link-local is blocked everywhere.** ``169.254.169.254`` is the cloud instance
metadata endpoint — on a VDS it answers with the machine's own credentials, to
anything on the box, with no authentication. No chat has a legitimate reason to
read it.

**Loopback and private ranges are blocked only in server mode.** On a desktop
``127.0.0.1`` is the user's own machine, and "read what my dev server is
serving on :3000" is a real request worth keeping. On a server-mode host it is
something else entirely: the backend's own ``/api/*`` sits on loopback behind a
reverse proxy (see ``server_mode``), and so does everything else the operator
runs on that box. The mode already draws this exact line for the request guard;
this is the same line drawn for outbound requests.

Every redirect hop is checked separately — a public URL that 302s to
``127.0.0.1`` is the cheapest way around a check that only looks at the input.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

# Categories that are never a legitimate web_fetch target, whatever the mode.
_ALWAYS = "link-local"
# Categories that are fine on a desktop and not on a shared host.
_LOCAL = "loopback or private-network"


def _category(raw: str) -> str | None:
    """Classify one resolved address, or None when it is an ordinary public one."""
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return None

    # ::ffff:127.0.0.1 is loopback wearing an IPv6 hat; judge the address it
    # actually names.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped

    if ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return _ALWAYS
    if ip.is_loopback or ip.is_private:
        return _LOCAL
    return None


def _resolve(host: str, port: int) -> list[str]:
    """Every address *host* resolves to. Empty when it does not resolve."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, OSError):
        return []
    return [str(info[4][0]) for info in infos]


async def blocked_reason(url: str, *, allow_local: bool) -> str | None:
    """Why *url* must not be fetched, or None when it may be.

    The hostname is resolved and *every* address it maps to is checked, so a
    public name pointing at a private address (``localtest.me`` and friends)
    does not walk straight through. A name that fails to resolve is allowed:
    the fetch will fail on its own, with a better message than this can give.
    """
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        return None
    port = parts.port or (443 if parts.scheme == "https" else 80)

    addresses = await asyncio.to_thread(_resolve, host, port)
    for address in addresses:
        category = _category(address)
        if category == _ALWAYS or (category == _LOCAL and not allow_local):
            return (
                f"{host} resolves to {address}, which is {category}. "
                "web_fetch is for public web content"
                + (
                    " — this backend runs in server mode, where the local network "
                    "is the host's own private surface."
                    if category == _LOCAL
                    else "; that address is the host's own metadata service."
                )
            )
    return None
