"""Edit file tool — smart string replacement with multiple fallback strategies.

Replacement pipeline sourced from:
https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Generator
from pathlib import Path
from typing import Callable

from agent.sandbox import SandboxPolicy
from agent.host_exec import host_read_text, host_write_bytes
from tools.base import BaseTool, ToolDefinition, ToolSchema

# Similarity thresholds for block-anchor fallback matching
_SINGLE_CANDIDATE_THRESHOLD = 0.0
_MULTI_CANDIDATE_THRESHOLD = 0.3

Replacer = Callable[[str, str], Generator[str, None, None]]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _normalize_line_endings(text: str) -> str:
    return text.replace("\r\n", "\n")


def _detect_line_ending(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def _convert_to_line_ending(text: str, ending: str) -> str:
    if ending == "\n":
        return text
    return text.replace("\n", "\r\n")


def _levenshtein(a: str, b: str) -> int:
    if not a or not b:
        return max(len(a), len(b))
    matrix = [
        [j if i == 0 else (i if j == 0 else 0) for j in range(len(b) + 1)]
        for i in range(len(a) + 1)
    ]
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            matrix[i][j] = min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            )
    return matrix[len(a)][len(b)]


# ---------------------------------------------------------------------------
# Replacers — each yields candidate substrings of `content` that match `find`
# ---------------------------------------------------------------------------


def simple_replacer(content: str, find: str) -> Generator[str, None, None]:
    yield find


def line_trimmed_replacer(content: str, find: str) -> Generator[str, None, None]:
    original_lines = content.split("\n")
    search_lines = find.split("\n")
    if search_lines and search_lines[-1] == "":
        search_lines.pop()

    for i in range(len(original_lines) - len(search_lines) + 1):
        if not all(
            original_lines[i + j].strip() == search_lines[j].strip()
            for j in range(len(search_lines))
        ):
            continue
        start = sum(len(original_lines[k]) + 1 for k in range(i))
        end = start
        for k in range(len(search_lines)):
            end += len(original_lines[i + k])
            if k < len(search_lines) - 1:
                end += 1
        yield content[start:end]


def block_anchor_replacer(content: str, find: str) -> Generator[str, None, None]:
    original_lines = content.split("\n")
    search_lines = find.split("\n")
    if len(search_lines) < 3:
        return
    if search_lines[-1] == "":
        search_lines.pop()

    first_search = search_lines[0].strip()
    last_search = search_lines[-1].strip()
    search_block_size = len(search_lines)

    candidates: list[tuple[int, int]] = []
    for i, line in enumerate(original_lines):
        if line.strip() != first_search:
            continue
        for j in range(i + 2, len(original_lines)):
            if original_lines[j].strip() == last_search:
                candidates.append((i, j))
                break

    if not candidates:
        return

    def _extract(start_line: int, end_line: int) -> str:
        ms = sum(len(original_lines[k]) + 1 for k in range(start_line))
        me = ms
        for k in range(start_line, end_line + 1):
            me += len(original_lines[k])
            if k < end_line:
                me += 1
        return content[ms:me]

    def _similarity(start_line: int, end_line: int, normalize: bool) -> float:
        actual = end_line - start_line + 1
        to_check = min(search_block_size - 2, actual - 2)
        if to_check <= 0:
            return 1.0
        total = 0.0
        for j in range(1, min(search_block_size - 1, actual - 1)):
            orig = original_lines[start_line + j].strip()
            srch = search_lines[j].strip()
            max_len = max(len(orig), len(srch))
            if max_len == 0:
                continue
            dist = _levenshtein(orig, srch)
            contrib = (1 - dist / max_len) / to_check if normalize else (1 - dist / max_len)
            total += contrib
            if normalize and total >= _SINGLE_CANDIDATE_THRESHOLD:
                break
        return total if normalize else total / to_check

    if len(candidates) == 1:
        s, e = candidates[0]
        if _similarity(s, e, normalize=True) >= _SINGLE_CANDIDATE_THRESHOLD:
            yield _extract(s, e)
        return

    best: tuple[int, int] | None = None
    max_sim = -1.0
    for s, e in candidates:
        sim = _similarity(s, e, normalize=False)
        if sim > max_sim:
            max_sim = sim
            best = (s, e)
    if max_sim >= _MULTI_CANDIDATE_THRESHOLD and best:
        yield _extract(best[0], best[1])


def whitespace_normalized_replacer(content: str, find: str) -> Generator[str, None, None]:
    def norm(text: str) -> str:
        return re.sub(r"\s+", " ", text).strip()

    normalized_find = norm(find)
    lines = content.split("\n")

    for line in lines:
        if norm(line) == normalized_find:
            yield line
        elif normalized_find in norm(line):
            words = find.strip().split()
            if words:
                pattern = r"\s+".join(re.escape(w) for w in words)
                try:
                    m = re.search(pattern, line)
                    if m:
                        yield m.group(0)
                except re.error:
                    pass

    find_lines = find.split("\n")
    if len(find_lines) > 1:
        for i in range(len(lines) - len(find_lines) + 1):
            block = "\n".join(lines[i : i + len(find_lines)])
            if norm(block) == normalized_find:
                yield block


def indentation_flexible_replacer(content: str, find: str) -> Generator[str, None, None]:
    def remove_indent(text: str) -> str:
        ls = text.split("\n")
        non_empty = [l for l in ls if l.strip()]
        if not non_empty:
            return text
        min_ind = min(len(l) - len(l.lstrip()) for l in non_empty)
        return "\n".join(l if not l.strip() else l[min_ind:] for l in ls)

    normalized_find = remove_indent(find)
    content_lines = content.split("\n")
    find_lines = find.split("\n")

    for i in range(len(content_lines) - len(find_lines) + 1):
        block = "\n".join(content_lines[i : i + len(find_lines)])
        if remove_indent(block) == normalized_find:
            yield block


def escape_normalized_replacer(content: str, find: str) -> Generator[str, None, None]:
    _map = {
        "n": "\n", "t": "\t", "r": "\r", "'": "'", '"': '"',
        "`": "`", "\\": "\\", "\n": "\n", "$": "$",
    }

    def unescape(s: str) -> str:
        return re.sub(r"\\(n|t|r|'|\"|`|\\|\n|\$)", lambda m: _map.get(m.group(1), m.group(0)), s)

    unescaped = unescape(find)
    if unescaped in content:
        yield unescaped

    lines = content.split("\n")
    find_lines = unescaped.split("\n")
    for i in range(len(lines) - len(find_lines) + 1):
        block = "\n".join(lines[i : i + len(find_lines)])
        if unescape(block) == unescaped:
            yield block


def trimmed_boundary_replacer(content: str, find: str) -> Generator[str, None, None]:
    trimmed = find.strip()
    if trimmed == find:
        return
    if trimmed in content:
        yield trimmed

    lines = content.split("\n")
    find_lines = find.split("\n")
    for i in range(len(lines) - len(find_lines) + 1):
        block = "\n".join(lines[i : i + len(find_lines)])
        if block.strip() == trimmed:
            yield block


def context_aware_replacer(content: str, find: str) -> Generator[str, None, None]:
    find_lines = find.split("\n")
    if len(find_lines) < 3:
        return
    if find_lines[-1] == "":
        find_lines.pop()

    content_lines = content.split("\n")
    first_line = find_lines[0].strip()
    last_line = find_lines[-1].strip()

    for i, line in enumerate(content_lines):
        if line.strip() != first_line:
            continue
        for j in range(i + 2, len(content_lines)):
            if content_lines[j].strip() == last_line:
                block_lines = content_lines[i : j + 1]
                if len(block_lines) == len(find_lines):
                    total = sum(
                        1 for k in range(1, len(block_lines) - 1)
                        if block_lines[k].strip() or find_lines[k].strip()
                    )
                    matching = sum(
                        1 for k in range(1, len(block_lines) - 1)
                        if (block_lines[k].strip() or find_lines[k].strip())
                        and block_lines[k].strip() == find_lines[k].strip()
                    )
                    if total == 0 or matching / total >= 0.5:
                        yield "\n".join(block_lines)
                break


def multi_occurrence_replacer(content: str, find: str) -> Generator[str, None, None]:
    start = 0
    while True:
        idx = content.find(find, start)
        if idx == -1:
            break
        yield find
        start = idx + len(find)


_REPLACERS: list[Replacer] = [
    simple_replacer,
    line_trimmed_replacer,
    block_anchor_replacer,
    whitespace_normalized_replacer,
    indentation_flexible_replacer,
    escape_normalized_replacer,
    trimmed_boundary_replacer,
    context_aware_replacer,
    multi_occurrence_replacer,
]


def smart_replace(content: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    """Apply the first matching replacer strategy. Raises ValueError on failure."""
    if old_string == new_string:
        raise ValueError("No changes to apply: old_string and new_string are identical.")

    not_found = True
    for replacer in _REPLACERS:
        for search in replacer(content, old_string):
            idx = content.find(search)
            if idx == -1:
                continue
            not_found = False
            if replace_all:
                return content.replace(search, new_string)
            last_idx = content.rfind(search)
            if idx != last_idx:
                continue
            return content[:idx] + new_string + content[idx + len(search) :]

    if not_found:
        raise ValueError(
            "Could not find old_string in the file. "
            "It must match exactly, including whitespace, indentation, and line endings."
        )
    raise ValueError(
        "Found multiple matches for old_string. "
        "Provide more surrounding context to make the match unique."
    )


def _diff_stats(old: str, new: str) -> tuple[int, int]:
    """Return (lines_added, lines_removed) between two strings."""
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old_lines, new_lines).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------


class EditFileTool(BaseTool):
    """Smart in-place file editor using cascading replacement strategies."""

    name = "edit_file"
    description = (
        "Edit a file by replacing a specific string with new content. "
        "Uses multiple fallback strategies (exact match → trimmed lines → block anchors → "
        "whitespace normalization → indentation flexibility → escape normalization → "
        "boundary trimming → context-aware → multi-occurrence) to locate old_string even when "
        "whitespace or indentation differ slightly. "
        "Set old_string to \"\" to create a new file or fully overwrite an existing one. "
        "Set replace_all=true to replace every occurrence of old_string. "
        "Accepts absolute Windows paths (C:\\...) and WSL/Linux paths (/home/...)."
    )

    def __init__(self) -> None:
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)

    def set_policy(self, policy: SandboxPolicy) -> None:
        self._policy = policy

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
                            "description": "Absolute path to the file to edit.",
                        },
                        "old_string": {
                            "type": "string",
                            "description": (
                                "The exact text to replace. "
                                "Pass an empty string to create or overwrite the file entirely."
                            ),
                        },
                        "new_string": {
                            "type": "string",
                            "description": "The text to replace old_string with.",
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "Replace all occurrences of old_string. Defaults to false.",
                            "default": False,
                        },
                    },
                    "required": ["path", "old_string", "new_string"],
                },
            )
        )

    async def execute(
        self,
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> str:
        denied = self._policy.check_write(path)
        if denied:
            return f"Error: {denied}"

        is_wsl = path.startswith("/")

        if old_string == "":
            # Create / overwrite
            if is_wsl:
                try:
                    await host_write_bytes(path, new_string.encode("utf-8"), append=False)
                except OSError as e:
                    return f"Error writing file: {e}"
            else:
                file_path = Path(path)
                try:
                    file_path.parent.mkdir(parents=True, exist_ok=True)
                    file_path.write_text(new_string, encoding="utf-8")
                except OSError as e:
                    return f"Error writing file: {e}"
            return f"Written {path} ({len(new_string.encode())} bytes)"

        # Read → replace → write
        if is_wsl:
            try:
                content = await host_read_text(path)
            except FileNotFoundError:
                return f"Error: file not found — {path}"
            except OSError as e:
                return f"Error reading file: {e}"
        else:
            file_path = Path(path)
            if not file_path.exists():
                return f"Error: file not found — {path}"
            if not file_path.is_file():
                return f"Error: not a regular file — {path}"
            try:
                content = file_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                return f"Error: file is not valid UTF-8 — {path}"
            except OSError as e:
                return f"Error reading file: {e}"

        ending = _detect_line_ending(content)
        old_norm = _convert_to_line_ending(_normalize_line_endings(old_string), ending)
        new_norm = _convert_to_line_ending(_normalize_line_endings(new_string), ending)

        try:
            new_content = smart_replace(content, old_norm, new_norm, replace_all)
        except ValueError as e:
            return f"Error: {e}"

        if is_wsl:
            try:
                await host_write_bytes(path, new_content.encode("utf-8"), append=False)
            except OSError as e:
                return f"Error writing file: {e}"
        else:
            try:
                file_path.write_text(new_content, encoding="utf-8")
            except OSError as e:
                return f"Error writing file: {e}"

        added, removed = _diff_stats(content, new_content)
        return f"Edit applied to {path} (+{added}/-{removed} lines)"
