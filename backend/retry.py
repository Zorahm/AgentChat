"""When to try a failed remote call again, and how long to wait first.

Every call that leaves this process — the model provider, a web fetch, an MCP
server — can fail for two very different reasons, and the difference is the
whole module. A dropped socket, a 503 or a rate limit is weather: the same
request sent again a moment later usually works. A rejected key, a malformed
request or a prompt that does not fit the context window is a fact: it will be
just as untrue on the tenth attempt, and the waiting in between is time the
user spends staring at a spinner instead of reading an error.

So the default answer is "do not retry". Only failures we can name as transient
earn another attempt; anything unrecognised — including bugs in our own code —
surfaces immediately.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class RetryPolicy:
    """How many attempts a call gets, and the shape of the waits between them."""

    attempts: int
    base: float
    cap: float


# The model call freezes the agent loop while it retries, which is the point:
# the conversation, the tool results and the half-written answer all survive a
# provider outage of a couple of minutes. 1+2+4+8+16+30·4 ≈ 3 minutes.
LLM_POLICY = RetryPolicy(attempts=10, base=1.0, cap=30.0)

# A tool retries far less. The model is waiting on the result and can route
# around a failed search; three minutes of invisible waiting inside one tool
# call is worse for the user than an error the model gets to react to.
TOOL_POLICY = RetryPolicy(attempts=4, base=1.0, cap=8.0)

# Transient by HTTP status: timeouts, "too early", rate limits, and every
# server-side failure. 529 is Anthropic's "overloaded".
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 529})

# Exception class names that mean the network, not the request. Matched by
# substring so litellm's `APIConnectionError`, httpx's `ConnectTimeout` and
# aiohttp's `ServerDisconnectedError` all land without importing any of them —
# this module stays a leaf, and a provider SDK swap cannot break it.
_RETRYABLE_NAMES = (
    "APIConnectionError",
    "ServiceUnavailable",
    "InternalServerError",
    "Overloaded",
    "RateLimit",
    "Timeout",
    "ConnectError",
    "ConnectionError",
    "RemoteProtocolError",
    "ProtocolError",
    "ReadError",
    "WriteError",
    "IncompleteRead",
    "ServerDisconnected",
)

# The subset of the above that means "nothing answered" rather than "something
# answered badly" — see looks_like_lost_connection.
_CONNECTION_NAMES = (
    "APIConnectionError",
    "ConnectError",
    "ConnectionError",
    "Timeout",
    "RemoteProtocolError",
    "ServerDisconnected",
    "IncompleteRead",
)

# Class names that are facts about the request. Checked FIRST, because several
# of them ("APITimeoutError" aside) can arrive wrapped in a generic APIError
# whose name would otherwise match the transient list.
_FATAL_NAMES = (
    "Authentication",
    "PermissionDenied",
    "NotFound",
    "BadRequest",
    "InvalidRequest",
    "UnprocessableEntity",
    "ContextWindowExceeded",
    "ContentPolicyViolation",
    "UnsupportedParams",
)

# Message fragments that mean the request itself is wrong, whatever status the
# provider chose to express that with. A gateway answering an over-long prompt
# with a 500 is common enough to be worth the string match: retried, it burns
# the full budget and still fails.
_FATAL_FRAGMENTS = (
    "context length",
    "context window",
    "maximum context",
    "too many tokens",
    "prompt is too long",
    "invalid api key",
    "incorrect api key",
    "api key not valid",
    "content policy",
    "content filter",
)


def _status_of(exc: BaseException) -> int | None:
    """The HTTP status a provider error carries, if it carries one."""
    raw = getattr(exc, "status_code", None)
    if isinstance(raw, bool):  # bool is an int; a True here is not a status
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str) and raw.isdigit():
        return int(raw)
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    return code if isinstance(code, int) else None


def _name_chain(exc: BaseException) -> str:
    """Class names of the exception and its causes, joined for substring tests.

    litellm wraps the transport's error, so the useful name is often on
    `__cause__` rather than on the exception the loop actually caught.
    """
    names: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        names.append(type(current).__name__)
        current = current.__cause__ or current.__context__
    return "|".join(names)


def is_retryable(exc: BaseException) -> bool:
    """Could sending this exact request again plausibly succeed?"""
    # Cancellation is the user pressing Stop (or the client hanging up). It is
    # never an error to recover from — retrying it would ignore the request.
    if isinstance(exc, asyncio.CancelledError):
        return False

    text = str(exc).lower()
    if any(fragment in text for fragment in _FATAL_FRAGMENTS):
        return False

    names = _name_chain(exc)
    if any(fatal in names for fatal in _FATAL_NAMES):
        return False

    status = _status_of(exc)
    if status is not None:
        return status in _RETRYABLE_STATUS

    if any(transient in names for transient in _RETRYABLE_NAMES):
        return True

    # Builtin socket failures reach here when nothing wrapped them.
    return isinstance(exc, (ConnectionError, TimeoutError, BrokenPipeError))


def looks_like_lost_connection(exc: BaseException) -> bool:
    """Did this failure happen before anything was reached?

    Separate from :func:`is_retryable`, which only decides whether to try again.
    This one decides what to TELL the user, and the two disagree on exactly the
    case that matters: litellm reports a refused connection with a status of
    500, so a caller reading the status alone would blame the provider for an
    outage that is really a stopped local server or a dropped Wi-Fi link.
    """
    if isinstance(exc, (ConnectionError, TimeoutError, BrokenPipeError)):
        return True
    names = _name_chain(exc)
    return any(marker in names for marker in _CONNECTION_NAMES)


def backoff_delay(policy: RetryPolicy, attempt: int, *, jitter: bool = True) -> float:
    """Seconds to wait before `attempt` (1-based), doubling up to the cap.

    Jitter is full rather than proportional: several chats reconnecting to the
    same provider after an outage should not all knock on the door at once.
    """
    exponent = max(0, attempt - 1)
    ceiling = min(policy.cap, policy.base * (2.0**exponent))
    return random.uniform(0.0, ceiling) if jitter else ceiling


def retry_after_seconds(exc: BaseException, cap: float = 30.0) -> float | None:
    """The provider's own `Retry-After`, in seconds, when it sent a usable one.

    Only the numeric form is honoured. The HTTP-date form is legal but rare
    from LLM providers, and parsing it wrong is worse than falling back to the
    schedule. Clamped, because a provider asking for an hour must not park the
    whole turn for an hour.
    """
    headers: Any = getattr(exc, "response_headers", None)
    if headers is None:
        response = getattr(exc, "response", None)
        headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
    except AttributeError:
        return None
    if raw is None:
        return None
    try:
        seconds = float(str(raw).strip())
    except ValueError:
        return None
    if seconds < 0:
        return None
    return min(seconds, cap)


def next_delay(policy: RetryPolicy, attempt: int, exc: BaseException) -> float:
    """How long to wait before `attempt`, honouring the provider's own ask."""
    asked = retry_after_seconds(exc, cap=policy.cap)
    return asked if asked is not None else backoff_delay(policy, attempt)


async def with_retry(
    operation: Callable[[], Awaitable[T]],
    policy: RetryPolicy = TOOL_POLICY,
    *,
    on_retry: Callable[[int, float, BaseException], Awaitable[None]] | None = None,
) -> T:
    """Run `operation`, trying again while the failure still looks transient.

    For tools, whose whole call is one round trip — unlike the agent loop, which
    has a half-streamed answer to rewind and a client to tell about it, and so
    spells the same policy out inline.
    """
    attempt = 1
    while True:
        try:
            return await operation()
        except Exception as exc:
            if attempt >= policy.attempts or not is_retryable(exc):
                raise
            delay = next_delay(policy, attempt, exc)
            if on_retry is not None:
                await on_retry(attempt, delay, exc)
            await asyncio.sleep(delay)
            attempt += 1
