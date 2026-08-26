"""How much of a tool's output is allowed into the conversation.

Most tools here produce text this app wrote, so their size is bounded by
construction. Two are not: ``bash_tool`` relays whatever a command printed, and
an MCP proxy relays whatever a third-party server returned. A single
``cat access.log`` or an over-eager MCP server therefore lands unbounded text in
``AgentLoop.messages`` — where it is re-sent on *every* subsequent request of
the turn, billed each time, and then persisted into the chat tree forever.

So those two clamp their output through here. The middle is what gets dropped:
a listing's useful part is at the top, a failure's is at the bottom (the last
lines of a traceback, the exit code), and the marker left behind tells the model
both that it happened and how to get the rest — re-running with ``head``/``tail``
/``grep`` is cheap, re-reading 200k characters is not.
"""

from __future__ import annotations

# ~30k characters is roughly 8k tokens — large enough that ordinary command
# output is never touched, small enough that one accident cannot dominate a
# context window.
MAX_TOOL_OUTPUT_CHARS = 30_000

# Errors are read from the end, listings from the start; keeping more of the
# head suits the common case without losing the tail of a traceback.
_HEAD_SHARE = 0.7


def clamp_output(
    text: str,
    *,
    limit: int = MAX_TOOL_OUTPUT_CHARS,
    hint: str = "Re-run narrowed down (head/tail/grep, or a smaller path) to see the rest.",
) -> str:
    """Return *text* unchanged, or with its middle replaced by a marker.

    The marker states the exact number of dropped characters so the model can
    tell a clipped result from a complete one, and carries *hint* — the way to
    obtain the missing part for this particular caller.
    """
    if len(text) <= limit:
        return text

    head_len = int(limit * _HEAD_SHARE)
    tail_len = limit - head_len
    dropped = len(text) - limit

    return (
        text[:head_len]
        + f"\n\n[... {dropped} characters cut from the middle "
        f"({len(text)} total, {limit} shown). {hint}]\n\n"
        + text[-tail_len:]
    )
