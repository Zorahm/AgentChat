"""Write file tool — the canonical write path for the ``write_file`` tool call.

Design follows OpenCode's Write tool, adapted for a chat agent (no LSP, no diff,
no permission prompts — sandbox checks live in :mod:`agent.sandbox`):

  * relative paths resolve against the chat working folder;
  * overwriting an existing file preserves its UTF-8 BOM and line endings;
  * the result says whether the file was *created* or *overwritten*;
  * nothing ever raises into the agent loop — every failure returns ``Error: …``.
"""

from __future__ import annotations

import ntpath
import posixpath
from pathlib import Path

from agent.sandbox import SandboxPolicy
from agent.host_exec import host_read_bytes, host_write_bytes
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.binary_formats import binary_format_refusal
from tools.read_ledger import ReadLedger
from tools.edit_file import (
    _convert_to_line_ending,
    _detect_line_ending,
    _normalize_line_endings,
)

# UTF-8 byte-order mark, in both its text (U+FEFF) and byte forms.
_BOM_TEXT = "﻿"
_BOM_BYTES = b"\xef\xbb\xbf"

# How much of an existing file is enough to answer "BOM?" and "CRLF?".
_SNIFF_BYTES = 65_536


def _looks_windows_abs(path: str) -> bool:
    """True for ``C:\\…`` / ``C:/…`` drive-absolute paths."""
    return len(path) >= 3 and path[1] == ":" and path[2] in ("\\", "/")


def _resolve_write_path(path: str, policy: SandboxPolicy) -> str:
    """Resolve *path* to an absolute path in the chat's filesystem namespace.

    Already-absolute paths are normalized and returned. A *relative* path is
    joined onto ``policy.chat_dir`` so the model can write ``notes.txt`` and
    have it land in the chat folder instead of erroring out. Cross-namespace
    paths (a Windows path in WSL mode or vice-versa) are returned unchanged so
    :meth:`SandboxPolicy.check_write` can reject them with a clear message.

    Each branch joins with its namespace's own module (``ntpath`` / ``posixpath``)
    rather than ``os.path``, so the result depends on the policy's shell and not
    on the host the backend happens to run on.
    """
    path = path.strip()
    if not path:
        return ""

    if policy.shell == "powershell":
        if _looks_windows_abs(path):
            return ntpath.normpath(path)
        if path.startswith("/"):
            return path  # wrong namespace — let check_write explain
        if policy.chat_dir:
            return ntpath.normpath(ntpath.join(policy.chat_dir, path))
        return path

    # wsl / posix
    if path.startswith("/"):
        return posixpath.normpath(path)
    if _looks_windows_abs(path):
        return path  # wrong namespace — let check_write explain
    if policy.chat_dir:
        return posixpath.normpath(posixpath.join(policy.chat_dir, path))
    return path


class WriteFileTool(BaseTool):
    """Write or append content to a file on the local filesystem."""

    name = "write_file"
    description = (
        "Write or append content to a file. Creates parent directories as needed "
        "and overwrites by default. A relative path is resolved against the current "
        "chat's working folder. Use append=true to add to an existing file without "
        "overwriting it. For files longer than 60 lines, split into multiple calls: "
        "first call with append=false (creates/overwrites), subsequent calls with append=true."
    )

    def __init__(self) -> None:
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)
        self._ledger: ReadLedger = ReadLedger()

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def set_ledger(self, ledger: ReadLedger) -> None:
        """Share the request's read ledger — see :mod:`tools.read_ledger`."""
        self._ledger = ledger

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "Where to write. Absolute is preferred (Windows C:\\… "
                                "or WSL /home/…); a relative path resolves against the "
                                "chat's working folder."
                            ),
                        },
                        "content": {
                            "type": "string",
                            "description": (
                                "The text content to write. "
                                "Keep each call under ~60 lines; use append=true for continuation."
                            ),
                        },
                        "append": {
                            "type": "boolean",
                            "description": (
                                "If true, append content to the existing file instead of overwriting. "
                                "Defaults to false."
                            ),
                            "default": False,
                        },
                    },
                    "required": ["path", "content"],
                },
            )
        )

    async def execute(self, path: str, content: str, append: bool = False) -> str:
        """Write or append *content* to the file at *path*.

        Wraps the whole operation so a single bad write can never raise into the
        agent loop — callers always get a string, ``Error: …`` on failure.
        """
        try:
            return await self._write(path, content, append)
        except Exception as exc:  # noqa: BLE001 — the tool must never raise into the loop
            return f"Error writing file: {exc}"

    # ------------------------------------------------------------------
    # internal
    # ------------------------------------------------------------------

    async def _write(self, path: str, content: str, append: bool) -> str:
        # Defensive: the model occasionally emits a non-string content value.
        if not isinstance(content, str):
            content = "" if content is None else str(content)

        # Checked before anything touches the filesystem: a .docx written as text
        # is a corrupt file, and the user only finds out when the download card
        # refuses to open.
        refusal = binary_format_refusal(path)
        if refusal:
            return refusal

        resolved = _resolve_write_path(path, self._policy)
        if not resolved:
            return "Error: empty path — provide a file path to write to."

        # A still-relative path means resolution had no chat_dir to anchor it.
        # Refuse rather than silently writing into the backend's own cwd.
        if not (resolved.startswith("/") or _looks_windows_abs(resolved)):
            return (
                f"Error: relative path {path!r} could not be resolved — this chat has "
                "no working folder. Provide an absolute path (C:\\… or /home/…)."
            )

        denied = self._policy.check_write(resolved)
        if denied:
            return f"Error: {denied}"

        is_wsl = resolved.startswith("/")

        if append:
            return await self._append(resolved, content, is_wsl)
        return await self._overwrite(resolved, content, is_wsl)

    async def _overwrite(self, path: str, content: str, is_wsl: bool) -> str:
        """Create or overwrite, preserving an existing file's BOM and line endings."""
        if not is_wsl and Path(path).is_dir():
            return f"Error: path is a directory, not a file — {path}"

        existing = await self._read_existing_prefix(path, is_wsl)
        existed = existing is not None

        # Only once we know the file is really there: refusing to "overwrite" a
        # path that does not exist yet would block creating a file next to an
        # attachment for no reason.
        if existed:
            blind = self._ledger.refuse_blind_overwrite(path)
            if blind:
                return blind

        if existing is not None:
            src_bom = existing.startswith(_BOM_BYTES)
            body = existing[len(_BOM_BYTES):] if src_bom else existing
            eol = _detect_line_ending(body.decode("utf-8", "replace"))
        else:
            # New file: follow the content's own ending (defaults to LF).
            src_bom = False
            eol = _detect_line_ending(content)

        next_bom = content.startswith(_BOM_TEXT)
        text = content[len(_BOM_TEXT):] if next_bom else content
        text = _convert_to_line_ending(_normalize_line_endings(text), eol)

        data = text.encode("utf-8")
        if src_bom or next_bom:
            data = _BOM_BYTES + data

        if is_wsl:
            await host_write_bytes(path, data, append=False)
        else:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)

        verb = "Overwrote" if existed else "Created"
        return f"{verb} {path} ({len(data)} bytes)"

    async def _append(self, path: str, content: str, is_wsl: bool) -> str:
        if not is_wsl and Path(path).is_dir():
            return f"Error: path is a directory, not a file — {path}"

        data = content.encode("utf-8")
        # Both branches report the same quantity — the bytes this call added.
        # They used to differ (added vs. total on disk), which is how a model
        # splitting a long file across appends came to believe it had written
        # far more than it had.
        if is_wsl:
            await host_write_bytes(path, data, append=True)
        else:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("ab") as f:
                f.write(data)
        return f"Appended {len(data)} bytes to {path}"

    @staticmethod
    async def _read_existing_prefix(path: str, is_wsl: bool) -> bytes | None:
        """Return the start of the file's current bytes, or None if it is new.

        This is the extra round-trip that buys BOM/line-ending preservation on
        overwrite. A *prefix* is enough for both: the BOM is the first three
        bytes, and a file whose first 64 KB contains no CRLF is not a CRLF file.
        Reading it whole meant overwriting a 200 MB file loaded 200 MB first —
        through a wsl.exe pipe on Windows — to answer two questions about its
        opening bytes.

        A missing file is the common case for a chat agent (it mostly creates
        new artifacts) and surfaces as None, not an error.
        """
        if is_wsl:
            try:
                return await host_read_bytes(path, max_bytes=_SNIFF_BYTES)
            except FileNotFoundError:
                return None
        p = Path(path)
        if not p.exists():
            return None
        with p.open("rb") as fp:
            return fp.read(_SNIFF_BYTES)
