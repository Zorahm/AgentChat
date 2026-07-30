"""The agent's memory tools: remember, recall, forget.

Three tools rather than one with a ``mode`` argument, because the model picks
tools by name far more reliably than it picks enum values — and because the
three have genuinely different shapes.

Each instance is bound to one agent for the lifetime of one request. That
binding is the security boundary: the agent id never reaches the model, so a
persona cannot talk its way into another agent's memory by naming it.
"""

from __future__ import annotations

from store.memory_store import MemoryStore
from schemas.memory import TEXT_MAX, TOPIC_MAX, MemoryCreate, MemoryFact
from tools.base import BaseTool, ToolDefinition, ToolSchema


def _render_hits(facts: list[MemoryFact]) -> str:
    lines = []
    for fact in facts:
        topic = f" [{fact.topic}]" if fact.topic else ""
        lines.append(f"- #{fact.id}{topic} {fact.text}")
    return "\n".join(lines)


class _AgentScopedTool(BaseTool):
    """Shared binding: one agent, one chat, one memory store."""

    def __init__(self, store: MemoryStore, agent_id: str, chat_id: str = "") -> None:
        self._store = store
        self._agent_id = agent_id
        self._chat_id = chat_id


class RememberTool(_AgentScopedTool):
    name = "remember"
    description = (
        "Save a fact worth carrying into future conversations — something about "
        "the user, about yourself, or about what has happened between you. Facts "
        "survive after this chat ends. Keep each one to a single self-contained "
        "sentence; re-saving a fact you already know just refreshes it."
    )

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": (
                                "The fact, as one self-contained sentence. Write it "
                                "so it still makes sense months from now, with no "
                                f"conversation around it. Max {TEXT_MAX} characters."
                            ),
                        },
                        "topic": {
                            "type": "string",
                            "description": (
                                "Optional one-word grouping label, e.g. 'user', "
                                f"'plot', 'world'. Max {TOPIC_MAX} characters."
                            ),
                        },
                        "pinned": {
                            "type": "boolean",
                            "description": (
                                "Pin a fact that must never scroll out of your "
                                "memory, such as the user's name. Pinned facts stay "
                                "visible no matter how much else you remember, so "
                                "pin sparingly."
                            ),
                        },
                    },
                    "required": ["text"],
                },
            )
        )

    async def execute(self, text: str, topic: str = "", pinned: bool = False) -> str:
        clean = text.strip()
        if not clean:
            return "Error: nothing to remember — `text` was empty."
        try:
            fact = self._store.add(
                self._agent_id,
                MemoryCreate(
                    text=clean[:TEXT_MAX],
                    topic=topic.strip()[:TOPIC_MAX],
                    pinned=pinned,
                    source_chat_id=self._chat_id or None,
                ),
            )
        except Exception as exc:  # noqa: BLE001 — a failed write must not kill the turn
            return f"Error saving memory: {exc}"
        pin_note = " (pinned)" if fact.pinned else ""
        return f"Remembered as #{fact.id}{pin_note}."


class RecallTool(_AgentScopedTool):
    name = "recall"
    description = (
        "Search your older memories — the ones not listed in your memory block. "
        "Use it when the conversation touches something you might have been told "
        "before but cannot see right now. A recalled fact returns to your memory "
        "block for the following turns."
    )

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": (
                                "Words likely to appear in the fact itself. This is "
                                "a keyword search over your own notes, not a question "
                                "to answer — 'ветеринар' beats 'кем работает Аня'."
                            ),
                        },
                        "limit": {
                            "type": "integer",
                            "description": "How many facts to return (default 5).",
                        },
                    },
                    "required": ["query"],
                },
            )
        )

    async def execute(self, query: str, limit: int = 5) -> str:
        try:
            facts = self._store.search(
                self._agent_id, query, limit=max(1, min(int(limit), 25))
            )
        except Exception as exc:  # noqa: BLE001
            return f"Error searching memory: {exc}"
        if not facts:
            return f"Nothing remembered about {query!r}."
        return _render_hits(facts)


class ForgetTool(_AgentScopedTool):
    name = "forget"
    description = (
        "Drop a memory that is no longer true or no longer worth keeping. "
        "Use the #id shown next to the fact in your memory block or in a recall "
        "result. To correct a fact rather than drop it, save the new version "
        "with `remember` instead."
    )

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "fact_id": {
                            "type": "integer",
                            "description": "The number after the # of the fact to drop.",
                        },
                    },
                    "required": ["fact_id"],
                },
            )
        )

    async def execute(self, fact_id: int) -> str:
        try:
            removed = self._store.delete(self._agent_id, int(fact_id))
        except (TypeError, ValueError):
            return f"Error: {fact_id!r} is not a fact id."
        if not removed:
            return f"No fact #{fact_id} in your memory."
        return f"Forgot #{fact_id}."


def build_memory_tools(
    store: MemoryStore, *, agent_id: str, chat_id: str = ""
) -> list[BaseTool]:
    """The three memory tools, bound to one agent for one request."""
    return [
        RememberTool(store, agent_id, chat_id),
        RecallTool(store, agent_id, chat_id),
        ForgetTool(store, agent_id, chat_id),
    ]
