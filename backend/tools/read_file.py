"""Read file tool — reads content from the local filesystem."""

from __future__ import annotations

import asyncio
from pathlib import Path

from agent.exec_common import trim_partial_utf8
from agent.sandbox import SandboxPolicy
from agent.host_exec import host_read_bytes
from tools.arg_coerce import as_int
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.read_ledger import ReadLedger

MAX_BYTES = 100_000

# Never pull more than this off disk, whatever offset/limit ask for. The tool
# can only ever *show* MAX_BYTES; the rest of the budget exists so offset/limit
# can reach deeper into a large file. Past it, memory is the binding constraint:
# on Windows the file travels back through a wsl.exe pipe the backend buffers
# whole, so an unbounded read of a video or a database file took the whole
# process down rather than returning an error the model could act on.
HARD_READ_BYTES = 5_000_000

# A NUL in the first few KB means this is not text. Checked because only one of
# the three read paths would otherwise say so: the Windows-local branch raises
# UnicodeDecodeError, while WSL and native POSIX decode leniently and would
# return a screenful of mojibake as if it had worked.
_SNIFF_BYTES = 8192


def _directory_hint(path: str) -> str:
    """Point the model at list_dir instead of failing with an errno."""
    return f"Error: {path} is a directory, not a file — use list_dir to see what is in it."


def _binary_hint(path: str) -> str:
    """Name the two tools that *can* read a non-text file."""
    return (
        f"Error: {path} is a binary file, not text. Use read_photo for an image, "
        "or bash_tool for anything else that needs decoding first."
    )


def _decode_text(raw: bytes) -> str | None:
    """Decode *raw* as text, or None when it is in some other encoding.

    Deliberately stricter than ``decode_loose``, which every shell-out site uses
    to salvage whatever a subprocess printed. Here the bytes are a file the user
    chose, and salvaging them means silently handing the model a screen of
    mojibake it will then reason about as if it were the file. Saying "I can't
    read this encoding" is the more useful answer, so only UTF-8 and the two
    BOM-tagged UTF-16 flavours are accepted.
    """
    for bom, encoding in ((b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be")):
        if raw.startswith(bom):
            try:
                return raw[len(bom):].decode(encoding, errors="replace")
            except UnicodeDecodeError:
                return None
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


class ReadFileTool(BaseTool):
    """Read the contents of a file at the given path."""

    name = "read_file"
    description = (
        "Read the contents of a file on the local filesystem. "
        "Accepts an absolute path. Returns file contents as a string. "
        "For large files, use offset (1-based line number to start from) and "
        "limit (max lines to return) to read in chunks."
    )

    def __init__(self) -> None:
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)
        self._ledger: ReadLedger = ReadLedger()

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

    def set_ledger(self, ledger: ReadLedger) -> None:
        """Share the request's read ledger, so a later write knows what was seen."""
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
                            "description": "Absolute path to the file to read.",
                        },
                        "offset": {
                            "type": "integer",
                            "description": (
                                "1-based line number to start reading from. "
                                "Defaults to 1 (start of file)."
                            ),
                        },
                        "limit": {
                            "type": "integer",
                            "description": (
                                "Maximum number of lines to return. "
                                "Defaults to the whole file (or MAX_BYTES)."
                            ),
                        },
                    },
                    "required": ["path"],
                },
            )
        )

    async def execute(self, path: str, offset: int = 1, limit: int = 0) -> str:
        """Read the file at *path* and return its content."""
        denied = self._policy.check_read(path)
        if denied:
            return f"Error: {denied}"

        # One byte past the ceiling: getting it back is how we learn the file is
        # larger without paying a second round trip for its size.
        try:
            raw = await self._read_prefix(path, HARD_READ_BYTES + 1)
        except FileNotFoundError:
            return f"Error: file not found — {path}"
        except IsADirectoryError:
            return _directory_hint(path)
        except OSError as e:
            if "Is a directory" in str(e):
                return _directory_hint(path)
            return f"Error reading file: {e}"

        if b"\x00" in raw[:_SNIFF_BYTES]:
            return _binary_hint(path)

        # Recorded once the read has actually succeeded — a failed read is not
        # knowledge of the file, and must not unlock overwriting it.
        self._ledger.record(path)

        content = _decode_text(trim_partial_utf8(raw[:HARD_READ_BYTES]))
        if content is None:
            return (
                f"Error: {path} is not UTF-8 text — cannot decode it. "
                "Convert it first with bash_tool (iconv -f <encoding> -t utf-8)."
            )

        # Kept out of `content` so it survives the line slicing below instead of
        # being cut off with the tail it is warning about.
        clipped_note = (
            f"\n\n[File is larger than {HARD_READ_BYTES} bytes — only the beginning "
            "was read. Use bash_tool (sed -n / grep / tail) to reach further in.]"
            if len(raw) > HARD_READ_BYTES
            else ""
        )

        total_lines = content.count("\n") + (1 if not content.endswith("\n") else 0)
        effective_offset = max(as_int(offset, 1), 1)
        line_limit = max(as_int(limit, 0), 0)

        if line_limit > 0 or effective_offset > 1:
            lines = content.splitlines(keepends=True)
            start = effective_offset - 1
            if start >= len(lines):
                return (
                    f"Error: offset {effective_offset} exceeds total lines ({len(lines)}) "
                    f"in {path}"
                )
            end = start + line_limit if line_limit > 0 else len(lines)
            selected = lines[start:end]
            result = "".join(selected)
            header = (
                f"[Lines {effective_offset}–{min(effective_offset + len(selected) - 1, len(lines))} "
                f"of {len(lines)} in {path}]"
            )
            if len(result.encode("utf-8")) > MAX_BYTES:
                truncated = result[:MAX_BYTES]
                return (
                    f"{header}\n\n"
                    f"[Truncated — showing ~{MAX_BYTES} bytes of this chunk]\n\n"
                    + truncated
                    + clipped_note
                )
            return f"{header}\n\n{result}{clipped_note}"

        if len(content) > MAX_BYTES:
            total_size = len(content)
            preview = content[:MAX_BYTES]
            preview_lines = preview.count("\n")
            return (
                f"[File: {path} — {total_lines} lines, {total_size} bytes]\n"
                f"[Showing first {preview_lines} lines. "
                f"Use offset/limit to read more.]\n\n"
                + preview
                + clipped_note
            )
        return content + clipped_note

    async def _read_prefix(self, path: str, budget: int) -> bytes:
        """Read at most *budget* bytes, in whichever namespace *path* belongs to.

        Raises the same exceptions the underlying filesystem would, so the
        caller maps every failure in one place. The Windows-local branch checks
        the file's kind up front because ``open`` alone reports a directory
        differently on Windows than the POSIX branches do.
        """
        if path.startswith("/"):
            return await host_read_bytes(path, max_bytes=budget)

        file_path = Path(path)
        if not file_path.exists():
            raise FileNotFoundError(path)
        if file_path.is_dir():
            raise IsADirectoryError(path)
        if not file_path.is_file():
            raise OSError(f"not a regular file — {path}")

        def _read() -> bytes:
            with file_path.open("rb") as fp:
                return fp.read(budget)

        return await asyncio.to_thread(_read)
