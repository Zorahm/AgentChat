"""Pydantic contracts for agent memory.

One fact = one short statement an agent chose to keep across chats. Facts are
scoped to an agent, never to a chat: ``source_chat_id`` records where a fact
came from, but the chat can be deleted without taking the fact with it.

Part of the ``schemas`` leaf package — imports nothing from the app.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

# A fact is a sentence, not a document. The cap is generous enough for a line
# of RP backstory and tight enough that one bad `remember` call can't swallow
# the whole core window.
TEXT_MAX = 2000
TOPIC_MAX = 64


class MemoryFact(BaseModel):
    """A stored fact, as returned by the store and the API."""

    id: int
    agent_id: str
    text: str
    # Free-form grouping label supplied by the model ("user", "plot", "world").
    # Deliberately not an enum: the useful buckets differ per persona, and an
    # enum would need a migration every time one is added.
    topic: str = ""
    pinned: bool = False
    # Ranking key for the core window: bumped on write AND on a recall hit, so
    # a fact that was just looked up returns to the always-on block.
    hot_at: int
    created_at: int
    hits: int = 0
    source_chat_id: str | None = None


class MemoryCreate(BaseModel):
    text: str = Field(min_length=1, max_length=TEXT_MAX)
    topic: str = Field(default="", max_length=TOPIC_MAX)
    pinned: bool = False
    source_chat_id: str | None = None


class MemoryUpdate(BaseModel):
    """A patch. Absent fields are left alone; present ones are validated."""

    text: str | None = Field(default=None, min_length=1, max_length=TEXT_MAX)
    topic: str | None = Field(default=None, max_length=TOPIC_MAX)
    pinned: bool | None = None
