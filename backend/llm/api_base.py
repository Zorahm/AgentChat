"""Classify a provider's API base URL.

Local OpenAI-compatible servers (LM Studio, Ollama, vLLM, llama.cpp) either
ignore the ``Authorization`` header or accept anything at all. Demanding a key
before we even try to reach them turns a working setup into a dead end, so the
"is this on my machine / my LAN?" question gets its own home here — both the
models fetcher and the settings view answer it the same way.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

# Hosts that never leave the machine, plus the name Docker hands containers for
# their host. ``.local`` (mDNS) is treated as LAN further down.
_LOCAL_HOSTNAMES = frozenset(
    {"localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"}
)

# Historical ids for local runtimes that predate the URL heuristic. Kept so an
# older settings.json keeps working even if its api_base looks remote.
_KEYLESS_PROVIDER_IDS = frozenset({"lmstudio", "litellm_proxy", "ollama"})


def is_local_base(api_base: str | None) -> bool:
    """True when ``api_base`` points at this machine or the local network."""
    if not api_base:
        return False
    raw = api_base if "://" in api_base else f"http://{api_base}"
    host = (urlsplit(raw).hostname or "").lower()
    if not host:
        return False
    if host in _LOCAL_HOSTNAMES or host.endswith(".local"):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return addr.is_loopback or addr.is_private or addr.is_link_local


def requires_api_key(provider_id: str, api_base: str | None) -> bool:
    """True when a missing key is worth refusing the request over.

    A remote endpoint without a key can only ever answer 401, so saying so up
    front is friendlier than a round trip. A local one usually works fine.
    """
    if provider_id in _KEYLESS_PROVIDER_IDS:
        return False
    return not is_local_base(api_base)
