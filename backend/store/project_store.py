"""SQLite-backed project persistence.

A project owns a custom instruction prompt and a set of files whose text is
extracted once at upload. Chats reference a project via ``chats.project_id``
(added by a migration in chat_store). Two tables:

  projects        — id, name, instructions, timestamps
  project_files   — id, project_id (FK), name, size, mime_type, extracted
                    text + status, on-disk path

Files live on disk (raw bytes) under ~/AgentChat/projects/{id}/files/; only
the extracted text is stored in the DB so the chat path can inject it without
re-reading the file.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT 'New project',
    instructions  TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_files (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    size            INTEGER NOT NULL DEFAULT 0,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    disk_path       TEXT NOT NULL DEFAULT '',
    extracted_text  TEXT NOT NULL DEFAULT '',
    extract_status  TEXT NOT NULL DEFAULT 'skipped',
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class ProjectStore:
    """Thread-safe SQLite project store. Mirrors ChatStore's locking model."""

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
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    # ------------------------------------------------------------------
    # projects
    # ------------------------------------------------------------------

    def list_projects(self) -> list[dict[str, Any]]:
        """Projects ordered by updated_at desc, each with a file count."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT p.id, p.name, p.instructions, p.created_at, p.updated_at, "
                "COUNT(f.id) AS file_count "
                "FROM projects p LEFT JOIN project_files f ON f.project_id = p.id "
                "GROUP BY p.id ORDER BY p.updated_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        """Full project including its files (without raw bytes)."""
        with self._lock:
            prow = self._conn.execute(
                "SELECT id, name, instructions, created_at, updated_at "
                "FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if prow is None:
                return None
            frows = self._conn.execute(
                "SELECT id, project_id, name, size, mime_type, disk_path, "
                "extract_status, created_at, length(extracted_text) AS text_len "
                "FROM project_files WHERE project_id = ? ORDER BY created_at ASC",
                (project_id,),
            ).fetchall()
        out = dict(prow)
        out["files"] = [dict(r) for r in frows]
        return out

    def create_project(self, project_id: str, name: str, instructions: str = "") -> dict[str, Any]:
        now = _now_ms()
        with self._lock:
            self._conn.execute(
                "INSERT INTO projects (id, name, instructions, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (project_id, name, instructions, now, now),
            )
        return self.get_project(project_id) or {}

    def update_project(
        self,
        project_id: str,
        name: str | None = None,
        instructions: str | None = None,
    ) -> dict[str, Any] | None:
        sets: list[str] = []
        params: list[Any] = []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if instructions is not None:
            sets.append("instructions = ?")
            params.append(instructions)
        if not sets:
            return self.get_project(project_id)
        sets.append("updated_at = ?")
        params.append(_now_ms())
        params.append(project_id)
        with self._lock:
            cur = self._conn.execute(
                f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", params
            )
            if cur.rowcount == 0:
                return None
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return cur.rowcount > 0

    # ------------------------------------------------------------------
    # files
    # ------------------------------------------------------------------

    def add_file(
        self,
        file_id: str,
        project_id: str,
        name: str,
        size: int,
        mime_type: str,
        disk_path: str,
        extracted_text: str,
        extract_status: str,
    ) -> dict[str, Any]:
        now = _now_ms()
        with self._lock:
            self._conn.execute(
                "INSERT INTO project_files "
                "(id, project_id, name, size, mime_type, disk_path, extracted_text, "
                "extract_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (file_id, project_id, name, size, mime_type, disk_path,
                 extracted_text, extract_status, now),
            )
            self._conn.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id)
            )
        return self.get_file_meta(file_id) or {}

    def get_file_meta(self, file_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, project_id, name, size, mime_type, disk_path, "
                "extract_status, created_at, length(extracted_text) AS text_len "
                "FROM project_files WHERE id = ?",
                (file_id,),
            ).fetchone()
        return dict(row) if row is not None else None

    def get_file_text(self, file_id: str) -> dict[str, Any] | None:
        """Full extracted text of a single file (for the preview modal)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id, project_id, name, mime_type, extract_status, extracted_text "
                "FROM project_files WHERE id = ?",
                (file_id,),
            ).fetchone()
        return dict(row) if row is not None else None

    def get_project_context(self, project_id: str) -> dict[str, Any] | None:
        """Return the data the chat path needs: name, instructions, and per-file
        extracted text + status + disk path. Heavier than ``get_project`` since
        it carries full extracted text — used only when building a request."""
        with self._lock:
            prow = self._conn.execute(
                "SELECT id, name, instructions FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if prow is None:
                return None
            frows = self._conn.execute(
                "SELECT name, disk_path, extracted_text, extract_status "
                "FROM project_files WHERE project_id = ? ORDER BY created_at ASC",
                (project_id,),
            ).fetchall()
        out = dict(prow)
        out["files"] = [dict(r) for r in frows]
        return out

    def delete_file(self, file_id: str) -> str | None:
        """Delete a file row. Returns its disk_path so the caller can unlink it."""
        with self._lock:
            row = self._conn.execute(
                "SELECT disk_path, project_id FROM project_files WHERE id = ?",
                (file_id,),
            ).fetchone()
            if row is None:
                return None
            self._conn.execute("DELETE FROM project_files WHERE id = ?", (file_id,))
            self._conn.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?",
                (_now_ms(), row["project_id"]),
            )
        return row["disk_path"]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
