"""SQLite history of every verification that has run.

Note what this is *not*: it is not where the badge comes from. A chat is stored
as one JSON tree (see :mod:`store.chat_store`) with no per-message rows, so the
verdict rides the tool call itself — which is what already survives a reload,
a branch switch and a retry. Duplicating it into a foreign-keyed table would
mean two sources of truth for the same badge and a migration for every UI field.

What this table adds is the part the tree cannot answer: *across* chats. Both
attempts at a refuted claim, kept side by side. How often `inconclusive` is
really coming back. Which claims were checked by the subagent rather than
deterministically. History that outlives the message it belongs to, for the
usage-style view in §P5.

Keyed on ``message_id`` — the per-turn id ``api.chat`` already mints for usage
logging — rather than on a row id that does not exist.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from schemas.math import VerifyOutcome

SCHEMA = """
CREATE TABLE IF NOT EXISTS message_verifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       TEXT    NOT NULL DEFAULT '',
    message_id    TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    problem       TEXT    NOT NULL,
    claim         TEXT    NOT NULL,
    result        TEXT    NOT NULL,
    verifier      TEXT    NOT NULL,
    attempt       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mv_message ON message_verifications(message_id);
CREATE INDEX IF NOT EXISTS idx_mv_chat ON message_verifications(chat_id, created_at DESC);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class VerificationStore:
    """Thread-safe append-only log of verification outcomes.

    Same connection discipline as :class:`store.chat_store.ChatStore`:
    ``check_same_thread=False`` with an external lock, because FastAPI handlers
    run on a thread pool.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)

    def record(self, *, chat_id: str, message_id: str, outcome: VerifyOutcome) -> int:
        """Append one outcome. Returns its row id."""
        payload = outcome.model_dump(mode="json")
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO message_verifications "
                "(chat_id, message_id, kind, status, problem, claim, result, verifier, "
                "attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    chat_id,
                    message_id,
                    outcome.kind,
                    outcome.status,
                    outcome.problem,
                    json.dumps(outcome.claim, ensure_ascii=False),
                    json.dumps(payload, ensure_ascii=False),
                    outcome.verifier,
                    outcome.attempt,
                    _now_ms(),
                ),
            )
        return int(cursor.lastrowid or 0)

    def for_message(self, message_id: str) -> list[dict[str, Any]]:
        """Every attempt for one turn, oldest first.

        Oldest first on purpose: a refuted first attempt followed by a verified
        second one only makes sense read in that order, and hiding the first is
        what turns the badge into theatre.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM message_verifications WHERE message_id = ? "
                "ORDER BY created_at ASC, id ASC",
                (message_id,),
            ).fetchall()
        return [_row(r) for r in rows]

    def for_chat(self, chat_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM message_verifications WHERE chat_id = ? "
                "ORDER BY created_at DESC LIMIT ?",
                (chat_id, max(1, min(limit, 1000))),
            ).fetchall()
        return [_row(r) for r in rows]

    def summary(self) -> dict[str, int]:
        """Counts per status — how much the badge is actually saying."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT status, COUNT(*) AS n FROM message_verifications GROUP BY status"
            ).fetchall()
        return {str(r["status"]): int(r["n"]) for r in rows}

    def delete_chat(self, chat_id: str) -> int:
        """Drop a deleted chat's history. Returns the number of rows removed."""
        if not chat_id:
            return 0
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM message_verifications WHERE chat_id = ?", (chat_id,)
            )
        return cursor.rowcount

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def _row(row: sqlite3.Row) -> dict[str, Any]:
    out = dict(row)
    for column in ("claim", "result"):
        try:
            out[column] = json.loads(out[column] or "{}")
        except json.JSONDecodeError:
            out[column] = {}
    return out
