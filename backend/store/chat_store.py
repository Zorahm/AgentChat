"""SQLite-backed chat persistence.

Schema: single ``chats`` table with the tree stored as a JSON blob in
``root_json``. We don't query into the tree, so flattening to per-message
rows would just slow writes down. If we ever add full-text search, we'll
maintain a denormalized FTS5 table alongside this one.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL DEFAULT 'New chat',
    dir_slug          TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    root_json         TEXT NOT NULL DEFAULT '[]',
    mcp_enabled_json  TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
"""

# Per-version ALTER statements for in-place migration on existing DBs.
# Each entry is tried; SQLite errors with "duplicate column name" are
# swallowed since they just mean the migration already ran.
_MIGRATIONS: tuple[str, ...] = (
    "ALTER TABLE chats ADD COLUMN mcp_enabled_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE chats ADD COLUMN project_id TEXT NOT NULL DEFAULT ''",
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class ChatStore:
    """Thread-safe SQLite chat store.

    One connection per store instance, guarded by a Lock. SQLite itself
    serialises writes, but Python's sqlite3 module also requires that a
    connection only be used from the thread it was created on UNLESS we
    pass ``check_same_thread=False`` and lock externally — which is what
    we do here, since FastAPI handlers run on a thread pool.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            str(db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we wrap in BEGIN/COMMIT when batching
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        for stmt in _MIGRATIONS:
            try:
                self._conn.execute(stmt)
            except sqlite3.OperationalError:
                # Column already exists from a previous run — skip.
                pass

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def list_chats(self) -> list[dict[str, Any]]:
        """Return chats ordered by updated_at desc, WITHOUT root_json (cheap)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, title, dir_slug, project_id, created_at, updated_at "
                "FROM chats ORDER BY updated_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_chat(self, chat_id: str) -> dict[str, Any] | None:
        """Return the full chat including parsed root tree."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id, title, dir_slug, project_id, created_at, updated_at, root_json, mcp_enabled_json "
                "FROM chats WHERE id = ?",
                (chat_id,),
            ).fetchone()
        if row is None:
            return None
        out = dict(row)
        try:
            out["root"] = json.loads(out.pop("root_json") or "[]")
        except json.JSONDecodeError:
            out["root"] = []
        try:
            mcp_enabled = json.loads(out.pop("mcp_enabled_json") or "[]")
        except json.JSONDecodeError:
            mcp_enabled = []
        out["mcp_enabled"] = mcp_enabled if isinstance(mcp_enabled, list) else []
        return out

    def update_chat(
        self,
        chat_id: str,
        title: str | None = None,
        dir_slug: str | None = None,
        root: list[Any] | None = None,
        mcp_enabled: list[str] | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Patch any of title / dir_slug / root / mcp_enabled / project_id. Touch updated_at."""
        sets: list[str] = []
        params: list[Any] = []
        if title is not None:
            sets.append("title = ?")
            params.append(title)
        if dir_slug is not None:
            sets.append("dir_slug = ?")
            params.append(dir_slug)
        if root is not None:
            sets.append("root_json = ?")
            params.append(json.dumps(root, ensure_ascii=False))
        if mcp_enabled is not None:
            sets.append("mcp_enabled_json = ?")
            params.append(json.dumps(list(mcp_enabled), ensure_ascii=False))
        if project_id is not None:
            sets.append("project_id = ?")
            params.append(project_id)
        if not sets:
            return self.get_chat(chat_id)

        sets.append("updated_at = ?")
        params.append(_now_ms())
        params.append(chat_id)

        with self._lock:
            cur = self._conn.execute(
                f"UPDATE chats SET {', '.join(sets)} WHERE id = ?",
                params,
            )
            if cur.rowcount == 0:
                return None
        return self.get_chat(chat_id)

    def delete_chat(self, chat_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        return cur.rowcount > 0

    def clear_project(self, project_id: str) -> int:
        """Unset project_id on every chat of a deleted project so they survive as
        standalone chats. Returns the number of rows updated."""
        if not project_id:
            return 0
        with self._lock:
            cur = self._conn.execute(
                "UPDATE chats SET project_id = '' WHERE project_id = ?",
                (project_id,),
            )
        return cur.rowcount

    def touch_chat(self, chat_id: str) -> None:
        """Update only the updated_at timestamp — lightweight post-stream save."""
        with self._lock:
            self._conn.execute(
                "UPDATE chats SET updated_at = ? WHERE id = ?",
                (_now_ms(), chat_id),
            )

    def upsert_chat(
        self,
        chat_id: str,
        title: str,
        dir_slug: str,
        root: list[Any] | None = None,
        created_at: int | None = None,
        mcp_enabled: list[str] | None = None,
        project_id: str = "",
    ) -> dict[str, Any]:
        """Insert or replace a chat — used by the migration path."""
        now = _now_ms()
        ts = created_at if created_at is not None else now
        root_blob = json.dumps(root or [], ensure_ascii=False)
        mcp_blob = json.dumps(list(mcp_enabled or []), ensure_ascii=False)
        with self._lock:
            self._conn.execute(
                "INSERT INTO chats (id, title, dir_slug, project_id, created_at, updated_at, root_json, mcp_enabled_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "title=excluded.title, dir_slug=excluded.dir_slug, "
                "project_id=excluded.project_id, "
                "updated_at=excluded.updated_at, root_json=excluded.root_json, "
                "mcp_enabled_json=excluded.mcp_enabled_json",
                (chat_id, title, dir_slug, project_id, ts, now, root_blob, mcp_blob),
            )
        return self.get_chat(chat_id) or {}

    def close(self) -> None:
        with self._lock:
            self._conn.close()
