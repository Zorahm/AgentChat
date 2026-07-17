"""SQLite-backed LLM usage/cost log.

Schema: ``usage_log`` (one row per LiteLLM call) + ``model_pricing`` (prices
fixed at request time, plus manual entries for models outside LiteLLM's price
map). See docs/agentchat-usage-tracking-design.md for the design rationale.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_log (
    id                INTEGER PRIMARY KEY,
    ts                INTEGER NOT NULL,
    chat_id           TEXT,
    message_id        TEXT,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL,
    usage_source      TEXT NOT NULL,
    latency_ms        INTEGER,
    context           TEXT NOT NULL DEFAULT 'chat'
);

CREATE INDEX IF NOT EXISTS idx_usage_ts        ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_model     ON usage_log(provider, model);
CREATE INDEX IF NOT EXISTS idx_usage_message   ON usage_log(message_id);
CREATE INDEX IF NOT EXISTS idx_usage_chat      ON usage_log(chat_id);

CREATE TABLE IF NOT EXISTS model_pricing (
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_per_1m  REAL,
    output_per_1m REAL,
    cached_per_1m REAL,
    updated_at    INTEGER NOT NULL,
    custom        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, model)
);
"""

# Per-version ALTER statements for in-place migration on existing DBs, same
# swallow-duplicate-column pattern as ChatStore.
_MIGRATIONS: tuple[str, ...] = (
    "ALTER TABLE usage_log ADD COLUMN breakdown_json TEXT",
)


def _now_s() -> int:
    return int(time.time())


class UsageStore:
    """Thread-safe SQLite store for LLM usage/cost tracking.

    Same connection-per-instance + lock pattern as ``ChatStore`` — SQLite
    serialises writes itself, but sqlite3 connections aren't safe to share
    across threads without ``check_same_thread=False`` plus an external lock.
    """

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
        for stmt in _MIGRATIONS:
            try:
                self._conn.execute(stmt)
            except sqlite3.OperationalError:
                # Column already exists from a previous run — skip.
                pass

    # ------------------------------------------------------------------
    # writes
    # ------------------------------------------------------------------

    def insert_usage(
        self,
        *,
        chat_id: str | None,
        message_id: str | None,
        provider: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        cached_tokens: int = 0,
        cost_usd: float | None,
        usage_source: str,
        latency_ms: int | None = None,
        context: str = "chat",
        ts: int | None = None,
        breakdown: dict[str, int] | None = None,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO usage_log "
                "(ts, chat_id, message_id, provider, model, prompt_tokens, "
                "completion_tokens, cached_tokens, cost_usd, usage_source, "
                "latency_ms, context, breakdown_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    ts if ts is not None else _now_s(),
                    chat_id or None,
                    message_id or None,
                    provider,
                    model,
                    prompt_tokens,
                    completion_tokens,
                    cached_tokens,
                    cost_usd,
                    usage_source,
                    latency_ms,
                    context,
                    json.dumps(breakdown) if breakdown else None,
                ),
            )

    def upsert_pricing(
        self,
        *,
        provider: str,
        model: str,
        input_per_1m: float | None,
        output_per_1m: float | None,
        cached_per_1m: float | None = None,
        custom: bool = True,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO model_pricing "
                "(provider, model, input_per_1m, output_per_1m, cached_per_1m, updated_at, custom) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(provider, model) DO UPDATE SET "
                "input_per_1m=excluded.input_per_1m, output_per_1m=excluded.output_per_1m, "
                "cached_per_1m=excluded.cached_per_1m, updated_at=excluded.updated_at, "
                "custom=excluded.custom",
                (provider, model, input_per_1m, output_per_1m, cached_per_1m, _now_s(), int(custom)),
            )

    # ------------------------------------------------------------------
    # reads
    # ------------------------------------------------------------------

    def get_pricing(self, provider: str, model: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM model_pricing WHERE provider = ? AND model = ?",
                (provider, model),
            ).fetchone()
        return dict(row) if row else None

    def get_message_usage(self, message_id: str) -> dict[str, Any] | None:
        """Aggregate every usage_log row for one assistant turn (message_id)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT SUM(prompt_tokens) AS prompt_tokens, "
                "SUM(completion_tokens) AS completion_tokens, "
                "SUM(cached_tokens) AS cached_tokens, "
                "SUM(cost_usd) AS cost_usd, "
                "COUNT(*) AS calls, "
                "SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_calls, "
                "SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_calls "
                "FROM usage_log WHERE message_id = ?",
                (message_id,),
            ).fetchone()
        if row is None or row["calls"] == 0:
            return None
        out = dict(row)
        out["usage_source"] = "estimated" if out["estimated_calls"] else "api"
        # Any call with an unpriced model makes the aggregate cost unreliable.
        if out["unknown_cost_calls"]:
            out["cost_usd"] = None
        out["breakdown"] = self._aggregate_breakdown(message_id)
        return out

    def _aggregate_breakdown(self, message_id: str) -> dict[str, int] | None:
        """Sum the per-call token breakdowns (system/tools/history/message) for
        one turn."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT breakdown_json FROM usage_log WHERE message_id = ? AND breakdown_json IS NOT NULL",
                (message_id,),
            ).fetchall()
        return self._sum_breakdown_rows(rows)

    def breakdown_summary(self, from_ts: int) -> dict[str, int] | None:
        """Sum token breakdowns across every call in the period — answers
        "where do our tokens actually go" (system prompt vs tool schemas vs
        conversation history vs the messages themselves)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT breakdown_json FROM usage_log WHERE ts >= ? AND breakdown_json IS NOT NULL",
                (from_ts,),
            ).fetchall()
        return self._sum_breakdown_rows(rows)

    @staticmethod
    def _sum_breakdown_rows(rows: list[sqlite3.Row]) -> dict[str, int] | None:
        """JSON-per-row storage is informational-only, so summing happens in
        Python rather than needing one SQL column per breakdown component."""
        if not rows:
            return None
        totals: dict[str, int] = {}
        for row in rows:
            try:
                parts = json.loads(row["breakdown_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            for key, value in parts.items():
                totals[key] = totals.get(key, 0) + int(value)
        return totals or None

    def summary(self, from_ts: int) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(cost_usd), 0) AS cost, "
                "COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, "
                "COUNT(*) AS calls "
                "FROM usage_log WHERE ts >= ?",
                (from_ts,),
            ).fetchone()
        return dict(row)

    def by_model(self, from_ts: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT provider, model, COALESCE(SUM(cost_usd), 0) AS cost, "
                "SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, "
                "SUM(cached_tokens) AS cached_tokens, COUNT(*) AS calls "
                "FROM usage_log WHERE ts >= ? "
                "GROUP BY provider, model ORDER BY cost DESC",
                (from_ts,),
            ).fetchall()
        return [dict(r) for r in rows]

    def daily(self, from_ts: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS day, provider, "
                "COALESCE(SUM(cost_usd), 0) AS cost, "
                "SUM(prompt_tokens + completion_tokens) AS tokens "
                "FROM usage_log WHERE ts >= ? "
                "GROUP BY day, provider ORDER BY day",
                (from_ts,),
            ).fetchall()
        return [dict(r) for r in rows]

    def top_chats(self, from_ts: int, limit: int = 10) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT chat_id, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls "
                "FROM usage_log WHERE ts >= ? AND chat_id IS NOT NULL "
                "GROUP BY chat_id ORDER BY cost DESC LIMIT ?",
                (from_ts, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
