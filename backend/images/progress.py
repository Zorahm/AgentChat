"""The progress-event vocabulary of an image generation — one source of truth.

Every backend publishes through :class:`ImageProgressEmitter`. ``agent.loop``
drains the tool's queue and forwards each event to the UI as ``tool_progress``;
``ui/src/utils/imageGen.ts`` reduces them back into the card's state. A field
added here has to be added there too — nothing else keeps the two in step.

The ``image`` event is what makes the card work at all: the file path is only
known *after* generation, so it cannot travel in the tool call's arguments the
way ``show_widget``'s HTML does.
"""

from __future__ import annotations

import asyncio
from typing import Any


class ImageProgressEmitter:
    """Publishes structured progress events onto a tool's progress queue.

    A ``None`` queue makes every method a no-op — what tests and any
    non-streaming caller want.
    """

    def __init__(self, queue: "asyncio.Queue[dict[str, Any]] | None" = None) -> None:
        self._queue = queue

    def _put(self, event: dict[str, Any]) -> None:
        if self._queue is not None:
            self._queue.put_nowait(event)

    def start(self, backend: str, prompt: str, count: int) -> None:
        """Generation began — the card renders its placeholder from this."""
        self._put(
            {
                "kind": "start",
                "backend": backend,
                "prompt": prompt[:400],
                "count": max(1, count),
            }
        )

    def progress(self, percent: float | None, status: str = "") -> None:
        """0..100 where the backend reports it; ``None`` = indeterminate."""
        event: dict[str, Any] = {"kind": "progress", "status": status}
        if percent is not None:
            event["percent"] = round(max(0.0, min(100.0, percent)), 1)
        self._put(event)

    def image(
        self,
        path: str,
        *,
        index: int = 0,
        width: int = 0,
        height: int = 0,
        seed: int | None = None,
    ) -> None:
        """One finished file landed in the chat folder."""
        self._put(
            {
                "kind": "image",
                "path": path,
                "index": index,
                "width": width,
                "height": height,
                "seed": seed,
            }
        )

    def failed(self, message: str) -> None:
        self._put({"kind": "failed", "message": message[:400]})

    def done(self) -> None:
        self._put({"kind": "done"})
