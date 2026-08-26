"""Search file *contents* without making the model write shell.

``list_dir`` finds files by name; this finds them by what is in them — "which of
my attachments mentions the invoice number" is an ordinary request, and the only
answer today is a shell command. That is a poor answer for two reasons. In
PowerShell mode (the fallback for every user without WSL) it means remembering
``Select-String`` and its very different output shape, and in any mode it means
the model has to get quoting right to search for a phrase.

So the tool writes the command and the model writes the query. The work still
happens in one process inside the sandbox — reading candidate files one by one
would cost a ``wsl.exe`` spawn per file, which is a minute for a folder of two
hundred — but which process, and how it is caged, stops being the model's
problem.

Matches come back as ``path:line: text``, the shape every model has seen a
million times, with the file paths made relative to the searched root so a long
chat-folder prefix isn't repeated on every line.
"""

from __future__ import annotations

import re
import shlex

from agent.sandbox import SandboxPolicy
from paths import DEFAULT_BASH_HOME, USER_NAME
from tools.arg_coerce import clamp_int
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.list_dir import NOISE_DIRS
from tools.output_budget import clamp_output
from tools.shell_exec import run_in_shell

DEFAULT_MAX_RESULTS = 50
MAX_RESULTS = 300
# A search is interactive; a scan that takes minutes means the pattern was wrong.
_TIMEOUT = 60


class GrepTool(BaseTool):
    """Find lines matching a regular expression across files."""

    name = "grep"
    description = (
        "Search inside files for a regular expression and return the matching "
        "lines as path:line:text. Use it to find where something is mentioned "
        "when you don't know which file it's in — it reads file contents, unlike "
        "list_dir, which only matches names. Searches the chat's working folder "
        "by default, skips binary files and machine-generated folders "
        "(node_modules, .git, …), and reports at most a few hundred matches."
    )

    def __init__(self, user_name: str = USER_NAME, user_home: str | None = None) -> None:
        self._user_name = user_name
        self._user_home = user_home or DEFAULT_BASH_HOME
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
                        "pattern": {
                            "type": "string",
                            "description": (
                                "Regular expression to look for. Plain text works "
                                "too — it is a valid regex. Prefer a distinctive "
                                "word over a long phrase; whitespace and line "
                                "breaks in the file may not be what you expect."
                            ),
                        },
                        "path": {
                            "type": "string",
                            "description": (
                                "Folder (or single file) to search. Defaults to the "
                                "chat's working folder."
                            ),
                        },
                        "glob": {
                            "type": "string",
                            "description": (
                                "Only search files whose name matches this glob, "
                                "e.g. '*.md'. Omit to search every text file."
                            ),
                        },
                        "case_sensitive": {
                            "type": "boolean",
                            "description": "Match case exactly. Defaults to false.",
                        },
                        "max_results": {
                            "type": "integer",
                            "description": (
                                f"Most matching lines to return (default "
                                f"{DEFAULT_MAX_RESULTS}, max {MAX_RESULTS})."
                            ),
                        },
                    },
                    "required": ["pattern"],
                },
            )
        )

    async def execute(
        self,
        pattern: str,
        path: str = "",
        glob: str = "",
        case_sensitive: bool = False,
        max_results: int = DEFAULT_MAX_RESULTS,
    ) -> str:
        pattern = (pattern or "").strip()
        if not pattern:
            return "Error: grep needs a non-empty 'pattern'."

        target = (path or "").strip() or self._policy.chat_dir
        if not target:
            return (
                "Error: nothing to search — this chat has no working folder. "
                "Pass an absolute path."
            )

        denied = self._policy.check_read(target)
        if denied:
            return f"Error: {denied}"

        cap = clamp_int(
            max_results, fallback=DEFAULT_MAX_RESULTS, low=1, high=MAX_RESULTS
        )
        command = (
            _powershell_command(pattern, target, glob, bool(case_sensitive), cap)
            if self._policy.shell == "powershell"
            else _grep_command(pattern, target, glob, bool(case_sensitive), cap)
        )

        result = await run_in_shell(
            command,
            policy=self._policy,
            user_name=self._user_name,
            user_home=self._user_home,
            timeout=_TIMEOUT,
        )
        if result.error:
            return f"Error running grep: {result.error}"

        lines = [line for line in result.stdout.splitlines() if line.strip()]
        # A match is a line shaped `path:line:text`, and only those are counted.
        # Anything else on stdout is the plumbing talking, not the search: a
        # broken WSL install prints its own diagnostic there, and taking those
        # lines at face value reported "2 matches" for a search that never ran.
        matches = [line for line in lines if _LINE.match(line)]

        if not matches:
            # The exit code is no help: the POSIX branch ends in `| head`, so the
            # pipeline reports head's success whatever grep did. Unparsed stdout
            # and stderr are the signal — and only when nothing matched at all,
            # since grep also writes to stderr about individual unreadable
            # subfolders while happily finding matches elsewhere.
            detail = (result.stderr.strip() or "\n".join(lines).strip())[:400]
            if detail:
                return f"Error running grep: {detail}"
            where = f"{glob} files under {target}" if glob else target
            return f"No matches for {pattern!r} in {where}."

        truncated = len(matches) > cap
        shown = [_relativize(line, target) for line in matches[:cap]]

        head = f"[{len(shown)} match(es) for {pattern!r} in {target}]"
        body = "\n".join(shown)
        tail = (
            f"\n\n[Stopped at {cap} matches — narrow the pattern, add a glob, "
            "or search a subfolder.]"
            if truncated
            else ""
        )
        return clamp_output(f"{head}\n\n{body}{tail}")


def _grep_command(pattern: str, target: str, glob: str, cased: bool, cap: int) -> str:
    """A POSIX ``grep`` invocation: recursive, line-numbered, binaries skipped."""
    flags = ["-rnI"]  # recursive, line numbers, skip binary files
    if not cased:
        flags.append("-i")
    parts = ["grep", *flags]
    if glob:
        parts.append(f"--include={shlex.quote(glob)}")
    for noise in sorted(NOISE_DIRS):
        parts.append(f"--exclude-dir={shlex.quote(noise)}")
    # `-e` so a pattern starting with `-` is a pattern, not an option. One extra
    # line past the cap is fetched so the caller can tell "exactly cap" from
    # "more than cap".
    parts += ["-e", shlex.quote(pattern), shlex.quote(target)]
    return " ".join(parts) + f" | head -n {cap + 1}"


def _powershell_command(pattern: str, target: str, glob: str, cased: bool, cap: int) -> str:
    """The Select-String equivalent, shaped to print the same path:line: text.

    Select-String is left in its object form (no ``-Raw``) precisely because the
    objects carry Path and LineNumber; the final ForEach-Object is what turns
    them into grep's output shape so both branches parse identically.
    """
    q = _ps_quote
    noise = ",".join(q(n) for n in sorted(NOISE_DIRS))
    filter_arg = f" -Filter {q(glob)}" if glob else ""
    case_arg = " -CaseSensitive" if cased else ""
    return (
        f"Get-ChildItem -Path {q(target)} -Recurse -File{filter_arg} "
        f"-ErrorAction SilentlyContinue "
        f"| Where-Object {{ -not ($_.FullName -split '[\\\\/]' "
        f"| Where-Object {{ @({noise}) -contains $_ }}) }} "
        f"| Select-String -Pattern {q(pattern)}{case_arg} -ErrorAction SilentlyContinue "
        f"| Select-Object -First {cap + 1} "
        f"| ForEach-Object {{ \"$($_.Path):$($_.LineNumber): $($_.Line.Trim())\" }}"
    )


def _ps_quote(value: str) -> str:
    """Single-quote for PowerShell, where the escape for ' is ''."""
    return "'" + value.replace("'", "''") + "'"


_LINE = re.compile(r"^(?P<path>.+?):(?P<line>\d+):\s?(?P<text>.*)$")


def _relativize(line: str, root: str) -> str:
    """Strip the searched root off a match's path, and trim the matched text.

    Both halves are about the same thing: a match is read for *what* matched and
    *where*, and a hundred repetitions of the same 80-character folder prefix
    (or a 4000-character minified line) buries both.
    """
    match = _LINE.match(line)
    if not match:
        return line[:300]

    path = match.group("path")
    for prefix in (root.rstrip("/\\") + "/", root.rstrip("/\\") + "\\"):
        if path.lower().startswith(prefix.lower()):
            path = path[len(prefix):]
            break
    text = match.group("text").strip()
    if len(text) > 240:
        text = text[:240] + " …"
    return f"{path}:{match.group('line')}: {text}"
