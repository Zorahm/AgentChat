"""The progress-event vocabulary of a verification — one source of truth.

``math_verify`` publishes through :class:`VerifyProgressEmitter`; ``agent.loop``
drains the queue and forwards each event to the UI as ``tool_progress``;
``ui/src/utils/verification.ts`` reduces them back into the badge's state. A
field added here has to be added there too — nothing else keeps the two in step.

The verdict travels this way rather than in the tool's return string because the
badge needs the *structure* (status, both check halves, the counterexample, the
problem it was checked against) while the model needs a sentence. Parsing one
back out of the other is how the two drift apart.
"""

from __future__ import annotations

import asyncio
from typing import Any


class VerifyProgressEmitter:
    """Publishes structured verification events onto a tool's progress queue.

    A ``None`` queue makes every method a no-op — what tests and any
    non-streaming caller want.
    """

    def __init__(self, queue: "asyncio.Queue[dict[str, Any]] | None" = None) -> None:
        self._queue = queue

    def _put(self, event: dict[str, Any]) -> None:
        if self._queue is not None:
            self._queue.put_nowait(event)

    def start(self, kind: str, problem: str, attempt: int, message_id: str = "") -> None:
        """A check began — the badge renders its pending state from this.

        ``message_id`` rides along so the **Re-check** button can file its result
        under the same turn. The UI has no other way to learn it: the id is
        minted server-side per turn for usage logging, and threading it through
        the chat tree would mean a new variant field to lose on every reload.
        """
        self._put(
            {
                "kind": "start",
                "verifyKind": kind,
                "problem": problem[:1200],
                "attempt": attempt,
                "messageId": message_id,
            }
        )

    def verdict(self, outcome: dict[str, Any]) -> None:
        """One finished :class:`schemas.math.VerifyOutcome`, already serialised."""
        self._put({"kind": "verdict", "outcome": outcome})

    def failed(self, message: str) -> None:
        """The tool itself broke. Deliberately distinct from a `refuted` verdict."""
        self._put({"kind": "failed", "message": message[:400]})

    def done(self) -> None:
        self._put({"kind": "done"})


class PlotProgressEmitter:
    """The same channel for ``math_plot``, whose payload is a finished SVG.

    The markup cannot ride the tool call's arguments the way ``show_widget``'s
    HTML does — the model asked for a curve, the *backend* drew it, so the
    picture only exists after the call. Same reason ``image_generate`` streams
    its paths.
    """

    def __init__(self, queue: "asyncio.Queue[dict[str, Any]] | None" = None) -> None:
        self._queue = queue

    def _put(self, event: dict[str, Any]) -> None:
        if self._queue is not None:
            self._queue.put_nowait(event)

    def start(self, kind: str, exprs: list[str], title: str) -> None:
        self._put(
            {
                "kind": "start",
                "plotKind": kind,
                "exprs": [str(e)[:200] for e in exprs[:8]],
                "title": title[:200],
            }
        )

    def svg(self, markup: str, *, title: str = "", warnings: list[str] | None = None) -> None:
        """The finished picture."""
        self._put(
            {
                "kind": "svg",
                "svg": markup,
                "title": title[:200],
                "warnings": [w[:200] for w in (warnings or [])][:4],
            }
        )

    def failed(self, message: str) -> None:
        self._put({"kind": "failed", "message": message[:400]})

    def done(self) -> None:
        self._put({"kind": "done"})
