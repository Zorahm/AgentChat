"""Registry of in-flight agent streams, keyed by chat id.

Deleting a chat removes its working folder with ``rm -rf``. If the agent is
still streaming for that chat, its tools may be writing into that same folder —
the purge then races live writes, and the model's last tool call fails against a
directory that vanished mid-turn. The delete route waits here first, so the
folder only disappears once nothing is using it.

Single-threaded by construction: every mutation happens on the event loop, so
no lock is needed.
"""

from __future__ import annotations

import asyncio


class ActiveStreams:
    """Counts running streams per chat and lets callers wait for a chat to idle."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        # Signalled (and dropped) the moment a chat's count reaches zero.
        self._idle: dict[str, asyncio.Event] = {}

    def begin(self, chat_id: str) -> None:
        if not chat_id:
            return
        self._counts[chat_id] = self._counts.get(chat_id, 0) + 1

    def end(self, chat_id: str) -> None:
        if not chat_id:
            return
        remaining = self._counts.get(chat_id, 0) - 1
        if remaining > 0:
            self._counts[chat_id] = remaining
            return
        self._counts.pop(chat_id, None)
        event = self._idle.pop(chat_id, None)
        if event is not None:
            event.set()

    def is_active(self, chat_id: str) -> bool:
        return self._counts.get(chat_id, 0) > 0

    async def wait_idle(self, chat_id: str, timeout: float) -> bool:
        """Block until no stream is running for *chat_id*.

        Returns False on timeout — the caller then decides whether the
        destructive follow-up is still safe (for chat deletion: it isn't).
        """
        if not chat_id or not self.is_active(chat_id):
            return True
        event = self._idle.setdefault(chat_id, asyncio.Event())
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return False
        return True
