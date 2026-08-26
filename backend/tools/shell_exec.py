"""Running one command in whichever shell this install actually has.

Four dialects (native bash, native zsh, bash-in-WSL, PowerShell), two
auto-fallbacks, one sandbox envelope. That was all private to ``bash_tool``
until a second tool needed it: ``grep`` searches file *contents*, and doing that
by reading files one at a time costs one ``wsl.exe`` spawn per file — a folder
of two hundred files takes a minute. The platform's own search does it in one
process, so the tool needs the same dispatch, the same cage, and the same
fallbacks that ``bash_tool`` already had.

The result is returned structured rather than formatted, because the two callers
read it differently: ``bash_tool`` shows the user whatever the command printed,
while ``grep`` has to know that exit code 1 means "no matches" and not "failed".
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
from dataclasses import dataclass

from agent.exec_common import decode_loose, run_blocking
from agent.posix_exec import host_tool_env
from agent.sandbox import SandboxPolicy


@dataclass(frozen=True)
class ShellResult:
    """What running a command produced.

    ``error`` is set only when no process ran at all (missing interpreter,
    timeout) — it is a statement about this app, not about the command, and the
    two must not be confused: a command that exits non-zero has still run and
    its output is worth reading.
    """

    stdout: str = ""
    stderr: str = ""
    returncode: int = 0
    error: str | None = None
    notice: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.returncode == 0


def _powershell_available() -> bool:
    return shutil.which("powershell") is not None or shutil.which("pwsh") is not None


async def run_in_shell(
    command: str,
    *,
    policy: SandboxPolicy,
    user_name: str,
    user_home: str,
    timeout: float,
) -> ShellResult:
    """Run *command* in the shell *policy* names, inside its sandbox envelope.

    On Windows there are two fallback layers for "wsl" mode, both of which exist
    so a user who never finished installing WSL still has a working chat:
      1. ``wsl.exe`` missing from PATH → PowerShell.
      2. WSL spawns but reports no installed distribution → PowerShell, once.
    """
    shell = policy.shell

    if shell in ("posix", "zsh"):
        return await _run_native(command, policy, user_name, user_home, timeout)

    has_powershell = _powershell_available()
    if shell == "wsl" and shutil.which("wsl") is None and has_powershell:
        shell = "powershell"

    if shell == "powershell":
        return await _run_powershell(command, policy, timeout)

    result = await _run_wsl(command, policy, user_name, user_home, timeout)
    if has_powershell and looks_like_wsl_setup_failure(result.stdout + result.stderr):
        retried = await _run_powershell(command, policy, timeout)
        return ShellResult(
            stdout=retried.stdout,
            stderr=retried.stderr,
            returncode=retried.returncode,
            error=retried.error,
            notice=(
                "WSL has no working distro installed. Command re-ran in "
                "PowerShell — set up WSL or switch to PowerShell mode in "
                "Settings → Shell."
            ),
        )
    return result


def _exports(user_name: str, user_home: str) -> str:
    """The outer env every POSIX dialect gets.

    Quoted rather than interpolated into single quotes by hand: a Windows
    account name containing an apostrophe would otherwise close the quote and
    turn the rest of the export into stray shell. The cage overrides HOME again
    via ``--setenv``; this layer exists for helpers that bypass ``wrap_bash``.
    """
    return (
        f"export USER={shlex.quote(user_name)} "
        f"USER_HOME={shlex.quote(user_home)} "
        f"HOME={shlex.quote(user_home)}; "
    )


async def _run_wsl(
    command: str, policy: SandboxPolicy, user_name: str, user_home: str, timeout: float
) -> ShellResult:
    full = _exports(user_name, user_home) + policy.wrap_bash(command)
    return await _spawn(["wsl.exe", "bash", "-c", full], timeout, missing="wsl.exe")


async def _run_native(
    command: str, policy: SandboxPolicy, user_name: str, user_home: str, timeout: float
) -> ShellResult:
    # wrap_bash emits plain POSIX shell, so the host's own interpreter runs it —
    # zsh only when the user explicitly picked it.
    binary = "zsh" if policy.shell == "zsh" else "bash"
    full = _exports(user_name, user_home) + policy.wrap_bash(command)
    return await _spawn(
        [binary, "-c", full], timeout, missing=binary, env=host_tool_env()
    )


async def _run_powershell(command: str, policy: SandboxPolicy, timeout: float) -> ShellResult:
    inner = policy.wrap_powershell(command)
    return await _spawn(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", inner],
        timeout,
        missing="powershell.exe",
    )


async def _spawn(
    argv: list[str], timeout: float, *, missing: str, env: dict[str, str] | None = None
) -> ShellResult:
    try:
        completed = await run_blocking(argv, timeout=timeout, env=env)
    except FileNotFoundError:
        return ShellResult(error=f"{missing} not found in PATH.", returncode=127)
    except subprocess.TimeoutExpired:
        return ShellResult(error=f"timed out after {int(timeout)}s.", returncode=124)
    except OSError as exc:
        return ShellResult(error=f"failed to spawn {missing}: {exc}", returncode=1)

    # decode_loose, not a bare utf-8 decode: wsl.exe's own diagnostics come back
    # as UTF-16LE, which utf-8 renders as NUL-interleaved text.
    return ShellResult(
        stdout=decode_loose(completed.stdout),
        stderr=decode_loose(completed.stderr),
        returncode=completed.returncode,
    )


def looks_like_wsl_setup_failure(output: str) -> bool:
    """Heuristic: WSL is on PATH but has no working distro.

    wsl.exe emits UTF-16-encoded messages like "Windows Subsystem for Linux has
    no installed distributions". ``decode_loose`` handles that encoding now, but
    NULs are still stripped here so the check keeps working on any output that
    reached us through a plain utf-8 decode.
    """
    if not output:
        return False
    flat = output.replace("\x00", "").lower()
    # WSL emits these strings in both English and localized form. The Russian
    # variant lands as mojibake after the utf-8/utf-16 decode dance, so we
    # only match the ASCII fragments that survive.
    needles = (
        "no installed distributions",
        "wsl --install",
        "wsl.exe --install",
        "wsl --list --online",
        "wsl.exe --list --online",
        "wsl is not installed",
        "the wsl optional component is not enabled",
    )
    return any(n in flat for n in needles)
