"""SQLite-backed agent memory: facts an agent keeps across chats.

**There is no separate archive table.** "Core" is the ranked window
:func:`MemoryStore.core` admits — pinned facts first, then the most recently
hot ones, until a character budget runs out. "Archive" is everything the window
left behind, reachable only through :func:`MemoryStore.search`. Eviction is
therefore free and lossless: a fact never moves and never dies, it just stops
being in the always-on prompt block until something makes it hot again.

Same connection-per-instance + lock pattern as ``ChatStore``/``UsageStore``.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Sequence
from pathlib import Path

from schemas.memory import MemoryCreate, MemoryFact, MemoryUpdate

# How much of the prompt the always-on block may occupy. Characters rather than
# tokens on purpose: the store must not depend on a tokenizer (and litellm's is
# far too slow to call per fact). ~6000 chars ≈ 1500 tokens.
CORE_CHAR_BUDGET = 6000
CORE_MAX_FACTS = 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory (
    id             INTEGER PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    text           TEXT NOT NULL,
    norm           TEXT NOT NULL,
    topic          TEXT NOT NULL DEFAULT '',
    pinned         INTEGER NOT NULL DEFAULT 0,
    hot_at         INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    hits           INTEGER NOT NULL DEFAULT 0,
    source_chat_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_norm ON memory(agent_id, norm);
CREATE INDEX IF NOT EXISTS idx_memory_rank ON memory(agent_id, pinned DESC, hot_at DESC);
"""

# Plain (not external-content) FTS5: every write already funnels through the
# three methods below, so manual sync is clearer than triggers — and it makes
# the no-FTS5 fallback a single branch instead of a separate schema.
_FTS_SCHEMA = "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, topic)"


def _now_s() -> int:
    return int(time.time())


def _normalize(text: str) -> str:
    """Dedup key: case- and whitespace-insensitive.

    Models re-assert the same fact with drifting spacing and capitalisation
    ("Зовут Аня" / "зовут  аня"), which would otherwise accumulate as separate
    rows and quietly crowd the core window.
    """
    return " ".join(text.split()).casefold()


def _escape_fts(query: str) -> str:
    """Quote each term so user/model text can't be read as FTS5 syntax.

    An unescaped ``-`` or ``"`` in a recall query raises OperationalError and
    would surface to the model as a tool error instead of "nothing found".
    """
    terms = [t.replace('"', '""') for t in query.split() if t]
    return " ".join(f'"{t}"' for t in terms)


class MemoryStore:
    """Thread-safe store for per-agent facts."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            str(db_path),
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)
        # FTS5 is compiled into most sqlite builds but not guaranteed in the
        # PyInstaller sidecar's — degrade to LIKE rather than failing to boot.
        try:
            self._conn.execute(_FTS_SCHEMA)
            self._fts = True
        except sqlite3.OperationalError:
            self._fts = False

    # ------------------------------------------------------------------
    # writes
    # ------------------------------------------------------------------

    def add(
        self, agent_id: str, fact: MemoryCreate, *, now: int | None = None
    ) -> MemoryFact:
        """Insert *fact*, or refresh the existing row with the same text.

        Re-asserting a known fact bumps ``hot_at`` (it's on the model's mind
        again) and can promote it to pinned, but never creates a duplicate.
        """
        ts = now if now is not None else _now_s()
        norm = _normalize(fact.text)
        with self._lock:
            cur = self._conn.execute(
                "SELECT id FROM memory WHERE agent_id = ? AND norm = ?", (agent_id, norm)
            )
            row = cur.fetchone()
            if row is None:
                cur = self._conn.execute(
                    "INSERT INTO memory "
                    "(agent_id, text, norm, topic, pinned, hot_at, created_at, hits, source_chat_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
                    (
                        agent_id,
                        fact.text,
                        norm,
                        fact.topic,
                        int(fact.pinned),
                        ts,
                        ts,
                        fact.source_chat_id,
                    ),
                )
                fact_id = int(cur.lastrowid or 0)
                self._index(fact_id, fact.text, fact.topic)
            else:
                fact_id = int(row["id"])
                self._conn.execute(
                    "UPDATE memory SET text = ?, topic = ?, pinned = pinned | ?, hot_at = ? "
                    "WHERE id = ?",
                    (fact.text, fact.topic, int(fact.pinned), ts, fact_id),
                )
                self._reindex(fact_id, fact.text, fact.topic)
            return self._get_locked(fact_id)

    def update(
        self, agent_id: str, fact_id: int, patch: MemoryUpdate
    ) -> MemoryFact | None:
        """Apply *patch*; return None when the fact isn't this agent's."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM memory WHERE id = ? AND agent_id = ?", (fact_id, agent_id)
            ).fetchone()
            if row is None:
                return None
            text = patch.text if patch.text is not None else row["text"]
            topic = patch.topic if patch.topic is not None else row["topic"]
            pinned = patch.pinned if patch.pinned is not None else bool(row["pinned"])
            self._conn.execute(
                "UPDATE memory SET text = ?, norm = ?, topic = ?, pinned = ? WHERE id = ?",
                (text, _normalize(text), topic, int(pinned), fact_id),
            )
            self._reindex(fact_id, text, topic)
            return self._get_locked(fact_id)

    def delete(self, agent_id: str, fact_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM memory WHERE id = ? AND agent_id = ?", (fact_id, agent_id)
            )
            if cur.rowcount == 0:
                return False
            self._unindex(fact_id)
            return True

    def delete_agent(self, agent_id: str) -> None:
        """Drop every fact of a deleted agent — memory outlives chats, not agents."""
        with self._lock:
            ids = [
                int(r["id"])
                for r in self._conn.execute(
                    "SELECT id FROM memory WHERE agent_id = ?", (agent_id,)
                )
            ]
            self._conn.execute("DELETE FROM memory WHERE agent_id = ?", (agent_id,))
            for fact_id in ids:
                self._unindex(fact_id)

    # ------------------------------------------------------------------
    # reads
    # ------------------------------------------------------------------

    def list_facts(self, agent_id: str) -> list[MemoryFact]:
        """Every fact, in core-window order. For the settings UI, not the prompt."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM memory WHERE agent_id = ? "
                "ORDER BY pinned DESC, hot_at DESC, id DESC",
                (agent_id,),
            ).fetchall()
        return [_to_fact(r) for r in rows]

    def count(self, agent_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM memory WHERE agent_id = ?", (agent_id,)
            ).fetchone()
        return int(row["n"])

    def core(
        self,
        agent_id: str,
        *,
        char_budget: int = CORE_CHAR_BUDGET,
        max_facts: int = CORE_MAX_FACTS,
    ) -> list[MemoryFact]:
        """The always-on window: pinned facts, then recent ones until the budget.

        Pinned facts ignore ``char_budget`` — the user asked for them by name,
        and silently dropping one would be the single most confusing failure
        this feature could have. The budget only trims the unpinned tail, and
        because pinned sort first, the first unpinned fact that doesn't fit
        ends the window (rather than letting a shorter, lower-ranked fact
        jump the queue).
        """
        spent = 0
        picked: list[MemoryFact] = []
        for fact in self.list_facts(agent_id)[:max_facts]:
            if fact.pinned:
                picked.append(fact)
                spent += len(fact.text)
                continue
            if spent + len(fact.text) > char_budget:
                break
            picked.append(fact)
            spent += len(fact.text)
        return picked

    def search(
        self, agent_id: str, query: str, *, limit: int = 5, now: int | None = None
    ) -> list[MemoryFact]:
        """Full-text search over this agent's archive.

        Mutates on read by design: a returned fact gets ``hot_at`` bumped and
        ``hits`` incremented, so recalling something pulls it back into the
        core window for the following turns.
        """
        if not query.strip():
            return []
        ts = now if now is not None else _now_s()
        with self._lock:
            rows = self._search_locked(agent_id, query, limit)
            for row in rows:
                self._conn.execute(
                    "UPDATE memory SET hot_at = ?, hits = hits + 1 WHERE id = ?",
                    (ts, int(row["id"])),
                )
            ids = [int(r["id"]) for r in rows]
            return [self._get_locked(i) for i in ids]

    # ------------------------------------------------------------------
    # internals — every one of these assumes the caller holds the lock
    # ------------------------------------------------------------------

    def _search_locked(self, agent_id: str, query: str, limit: int) -> list[sqlite3.Row]:
        if self._fts:
            match = _escape_fts(query)
            if not match:
                return []
            try:
                return list(
                    self._conn.execute(
                        "SELECT m.* FROM memory_fts f "
                        "JOIN memory m ON m.id = f.rowid "
                        "WHERE memory_fts MATCH ? AND m.agent_id = ? "
                        "ORDER BY rank LIMIT ?",
                        (match, agent_id, limit),
                    )
                )
            except sqlite3.OperationalError:
                pass  # malformed query for FTS5 — fall through to LIKE
        like = f"%{query.strip()}%"
        return list(
            self._conn.execute(
                "SELECT * FROM memory WHERE agent_id = ? AND (text LIKE ? OR topic LIKE ?) "
                "ORDER BY pinned DESC, hot_at DESC LIMIT ?",
                (agent_id, like, like, limit),
            )
        )

    def _index(self, fact_id: int, text: str, topic: str) -> None:
        if self._fts:
            self._conn.execute(
                "INSERT INTO memory_fts(rowid, text, topic) VALUES (?, ?, ?)",
                (fact_id, text, topic),
            )

    def _reindex(self, fact_id: int, text: str, topic: str) -> None:
        self._unindex(fact_id)
        self._index(fact_id, text, topic)

    def _unindex(self, fact_id: int) -> None:
        if self._fts:
            self._conn.execute("DELETE FROM memory_fts WHERE rowid = ?", (fact_id,))

    def _get_locked(self, fact_id: int) -> MemoryFact:
        row = self._conn.execute("SELECT * FROM memory WHERE id = ?", (fact_id,)).fetchone()
        return _to_fact(row)


def _to_fact(row: sqlite3.Row) -> MemoryFact:
    return MemoryFact(
        id=int(row["id"]),
        agent_id=str(row["agent_id"]),
        text=str(row["text"]),
        topic=str(row["topic"]),
        pinned=bool(row["pinned"]),
        hot_at=int(row["hot_at"]),
        created_at=int(row["created_at"]),
        hits=int(row["hits"]),
        source_chat_id=row["source_chat_id"],
    )


def render_core_block(facts: Sequence[MemoryFact], *, has_search: bool = True) -> str:
    """Render the always-on memory block appended to the system prompt.

    The pointer to ``recall`` is what makes the archive discoverable at all —
    without it the model treats the core window as the whole of its memory. But
    an agent whose tool policy is ``none`` has no ``recall`` to call, so
    ``has_search`` drops that sentence (and the ids with it): a prompt must
    never describe a tool the request didn't wire, or the model spends turns
    reaching for something that isn't there.
    """
    if not facts:
        return ""
    lines = []
    for fact in facts:
        topic = f" [{fact.topic}]" if fact.topic else ""
        prefix = f"- #{fact.id}{topic} " if has_search else f"-{topic} "
        lines.append(f"{prefix}{fact.text}")
    body = "\n".join(lines)
    intro = "Facts you chose to remember about this user and your shared history."
    if has_search:
        intro += (
            " Older facts are not listed here — use `recall` to search them, and "
            "`forget` with an id above when something is no longer true."
        )
    return f"## Memory\n\n{intro}\n\n{body}"
