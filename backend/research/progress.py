"""The progress-event vocabulary of a research run — one source of truth.

The lead, the fan-out and the workers all publish through :class:`ProgressEmitter`.
``agent.loop`` forwards whatever lands on the queue to the UI as ``tool_progress``,
and ``ui/src/utils/research.ts`` reduces those into the panel's tree. A field added
here has to be added there too — nothing else keeps the two in step.

``note`` is deliberately free-form: it is the escape hatch that lets the model say
something the fixed vocabulary has no word for, instead of us growing the vocabulary
every time the model has something to report.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

#: Agent id reserved for the lead's own searches and reads.
LEAD_AGENT_ID = "lead"

AgentStatus = Literal["ok", "failed", "timeout", "cancelled"]
StepKind = Literal["search", "read"]


class ProgressEmitter:
    """Publishes structured progress events onto a tool's progress queue.

    A ``None`` queue makes every method a no-op, which is what tests and any
    non-streaming caller want.
    """

    def __init__(self, queue: "asyncio.Queue[dict[str, Any]] | None" = None) -> None:
        self._queue = queue

    def _put(self, event: dict[str, Any]) -> None:
        if self._queue is not None:
            self._queue.put_nowait(event)

    def plan(self, steps: list[dict[str, str]]) -> None:
        """The lead's plan — the panel's top-level list of sub-questions."""
        self._put({"kind": "plan", "steps": steps})

    def agent_start(self, agent_id: str, title: str) -> None:
        self._put({"kind": "agent_start", "agentId": agent_id, "title": title})

    def agent_step(self, agent_id: str, step: StepKind, value: str) -> None:
        """One search query or one page read, attributed to an agent."""
        self._put({"kind": "agent_step", "agentId": agent_id, "step": step, "value": value})

    def agent_sources(self, agent_id: str, urls: list[str]) -> None:
        if urls:
            self._put({"kind": "agent_sources", "agentId": agent_id, "urls": urls})

    def agent_end(
        self,
        agent_id: str,
        status: AgentStatus,
        *,
        sources: int = 0,
        summary: str = "",
    ) -> None:
        self._put(
            {
                "kind": "agent_end",
                "agentId": agent_id,
                "status": status,
                "sources": sources,
                "summary": summary,
            }
        )

    def note(self, text: str) -> None:
        """Free-form status line authored by the model."""
        cleaned = text.strip()
        if cleaned:
            self._put({"kind": "note", "text": cleaned[:400]})

    def done(self, title: str, path: str) -> None:
        self._put({"kind": "done", "title": title, "path": path})
