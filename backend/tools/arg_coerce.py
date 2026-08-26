"""Coercing the numbers a model puts in a tool call.

A JSON-schema ``"type": "integer"`` is a request, not a guarantee: models send
``"5"``, ``5.0``, ``null``, and occasionally a word. Python's own `int()` then
raises `TypeError` deep inside the tool — which the registry can only describe
as an argument problem, sending the model to fix a call whose *intent* was
perfectly clear.

So every numeric tool argument passes through here first and falls back to the
tool's default instead. The alternative — rejecting the call — spends a whole
round trip re-litigating a detail neither side cares about.
"""

from __future__ import annotations


def as_int(value: object, fallback: int) -> int:
    """Read *value* as an int, or return *fallback* when it isn't one.

    ``bool`` is deliberately excluded even though it is an ``int`` subclass:
    ``True`` arriving where a count belongs is a mistake, not the number 1.
    """
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return fallback
    return fallback


def clamp_int(value: object, *, fallback: int, low: int, high: int) -> int:
    """:func:`as_int`, then held inside ``low..high``."""
    return max(low, min(as_int(value, fallback), high))
