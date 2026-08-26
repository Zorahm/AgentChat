"""The grep tool: what it asks the shell for, and what it makes of the answer.

The shell itself is stubbed. That is not a convenience — the two branches run on
different operating systems and only one can ever execute on a given host, so
fabricating the result is the only way to pin both. It is also how the one bug
found in live testing is kept fixed: a broken WSL install writes its own
diagnostic to *stdout*, and counting those lines as matches reported "2 matches"
for a search that never ran.
"""

from __future__ import annotations

import shlex
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy
from tools import grep_tool as grep_mod
from tools.grep_tool import GrepTool
from tools.shell_exec import ShellResult

CHAT = "/home/u/chat"


def _tool(shell: str = "wsl") -> GrepTool:
    tool = GrepTool()
    tool.set_policy(SandboxPolicy(chat_dir=CHAT, shell=shell, unrestricted=True))
    return tool


def _stub(
    monkeypatch: pytest.MonkeyPatch,
    *,
    stdout: str = "",
    stderr: str = "",
    returncode: int = 0,
    error: str | None = None,
) -> list[str]:
    """Replace the shell with a fixed answer; return the list it records commands in."""
    seen: list[str] = []

    async def fake_run(command: str, **_: object) -> ShellResult:
        seen.append(command)
        return ShellResult(
            stdout=stdout, stderr=stderr, returncode=returncode, error=error
        )

    monkeypatch.setattr(grep_mod, "run_in_shell", fake_run)
    return seen


class TestCommandConstruction:
    @pytest.mark.asyncio
    async def test_posix_branch_skips_binaries_and_noise(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen = _stub(monkeypatch)
        await _tool().execute(pattern="invoice")

        cmd = seen[0]
        assert cmd.startswith("grep -rnI")  # recursive, numbered, binaries skipped
        assert "--exclude-dir=node_modules" in cmd
        assert "--exclude-dir=.git" in cmd

    @pytest.mark.asyncio
    async def test_case_insensitive_by_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _stub(monkeypatch)
        await _tool().execute(pattern="invoice")

        assert "-i" in seen[0].split()

    @pytest.mark.asyncio
    async def test_case_sensitive_drops_the_flag(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _stub(monkeypatch)
        await _tool().execute(pattern="Invoice", case_sensitive=True)

        assert "-i" not in seen[0].split()

    @pytest.mark.asyncio
    async def test_a_pattern_starting_with_a_dash_is_still_a_pattern(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without `-e` grep reads it as an option and fails on a valid search."""
        seen = _stub(monkeypatch)
        await _tool().execute(pattern="--fix")

        assert "-e --fix" in seen[0]

    @pytest.mark.asyncio
    async def test_the_glob_becomes_an_include(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _stub(monkeypatch)
        await _tool().execute(pattern="x", glob="*.md")

        assert "--include='*.md'" in seen[0]

    @pytest.mark.asyncio
    async def test_powershell_mode_uses_select_string(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen = _stub(monkeypatch)
        tool = GrepTool()
        tool.set_policy(
            SandboxPolicy(chat_dir="C:\\chat", shell="powershell", unrestricted=True)
        )
        await tool.execute(pattern="invoice")

        assert "Select-String" in seen[0]
        assert "grep" not in seen[0]

    @pytest.mark.asyncio
    async def test_a_quote_in_the_pattern_cannot_break_out(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen = _stub(monkeypatch)
        await _tool().execute(pattern="it's; rm -rf /")

        # The property that matters is that the shell sees it as ONE argument,
        # so ask a shell parser rather than eyeballing the quoting.
        argv = shlex.split(seen[0].split(" | head", 1)[0])
        assert argv[argv.index("-e") + 1] == "it's; rm -rf /"


class TestResultParsing:
    @pytest.mark.asyncio
    async def test_matches_are_relative_to_the_searched_root(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub(monkeypatch, stdout=f"{CHAT}/uploads/a.md:12:  invoice 5\n")

        out = await _tool().execute(pattern="invoice")

        assert "uploads/a.md:12: invoice 5" in out
        assert f"{CHAT}/uploads" not in out.split("\n\n", 1)[1]

    @pytest.mark.asyncio
    async def test_a_very_long_line_is_trimmed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _stub(monkeypatch, stdout=f"{CHAT}/min.js:1:" + "x" * 5_000 + "\n")

        out = await _tool().execute(pattern="x")

        assert len(out) < 1_000

    @pytest.mark.asyncio
    async def test_nothing_found_is_not_an_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _stub(monkeypatch, returncode=1)

        out = await _tool().execute(pattern="nope")

        assert out.startswith("No matches")
        assert "Error" not in out

    @pytest.mark.asyncio
    async def test_the_cap_is_reported_not_silently_applied(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub(monkeypatch, stdout="".join(f"{CHAT}/a.md:{i}: hit\n" for i in range(1, 60)))

        out = await _tool().execute(pattern="hit", max_results=5)

        assert "Stopped at 5 matches" in out
        assert out.count("hit") <= 8  # 5 matches + the header/footer mentions


class TestFailuresAreNotResults:
    @pytest.mark.asyncio
    async def test_plumbing_output_on_stdout_is_not_counted_as_matches(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A broken WSL install prints this to stdout, not stderr. Counting the
        lines reported "2 matches" for a search that never ran."""
        _stub(
            monkeypatch,
            stdout=(
                'Failed to attach disk "C:\\...\\ext4.vhdx" to WSL2\n'
                "Error code: Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_PATH_NOT_FOUND\n"
            ),
        )

        out = await _tool().execute(pattern="invoice")

        assert out.startswith("Error running grep")
        assert "match(es)" not in out

    @pytest.mark.asyncio
    async def test_stderr_with_no_matches_is_an_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub(monkeypatch, stderr="grep: /home/u/chat: Permission denied", returncode=2)

        out = await _tool().execute(pattern="x")

        assert out.startswith("Error running grep")

    @pytest.mark.asyncio
    async def test_stderr_alongside_real_matches_does_not_hide_them(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """grep complains about one unreadable subfolder while succeeding
        everywhere else; that is a result, not a failure."""
        _stub(
            monkeypatch,
            stdout=f"{CHAT}/a.md:3: found\n",
            stderr="grep: /home/u/chat/secret: Permission denied",
            returncode=2,
        )

        out = await _tool().execute(pattern="found")

        assert "a.md:3: found" in out
        assert not out.startswith("Error")

    @pytest.mark.asyncio
    async def test_a_shell_that_never_started_says_so(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub(monkeypatch, error="wsl.exe not found in PATH.")

        out = await _tool().execute(pattern="x")

        assert out.startswith("Error running grep")


class TestGuards:
    @pytest.mark.asyncio
    async def test_an_empty_pattern_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _stub(monkeypatch)
        assert (await _tool().execute(pattern="   ")).startswith("Error:")

    @pytest.mark.asyncio
    async def test_the_sandbox_still_applies(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _stub(monkeypatch)
        tool = GrepTool()
        tool.set_policy(SandboxPolicy(chat_dir=CHAT, shell="wsl"))

        out = await tool.execute(pattern="x", path="/etc")

        assert out.startswith("Error: Sandbox")

    @pytest.mark.asyncio
    async def test_no_chat_folder_and_no_path_explains_itself(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub(monkeypatch)
        tool = GrepTool()
        tool.set_policy(SandboxPolicy(unrestricted=True))

        assert "no working folder" in await tool.execute(pattern="x")
