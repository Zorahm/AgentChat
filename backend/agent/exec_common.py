"""Shared subprocess plumbing — blocking subprocess in a thread.

Platform-agnostic helpers used by every shell-out site (native POSIX, WSL,
PowerShell, dependency probes). asyncio.create_subprocess_exec raises
NotImplementedError on Windows SelectorEventLoop (which uvicorn sometimes
installs); running blocking subprocess.run in asyncio.to_thread works on any
event loop policy.
"""

from __future__ import annotations

import asyncio
import subprocess

from shell import NO_WINDOW


def decode_loose(data: bytes) -> str:
    """Best-effort bytes → str. WSL CLI sometimes emits UTF-16LE."""
    if not data:
        return ""
    try:
        s = data.decode("utf-8")
        if "\x00" in s:
            raise UnicodeDecodeError("utf-8", data, 0, 1, "looks like utf-16")
        return s
    except UnicodeDecodeError:
        try:
            return data.decode("utf-16-le").replace("\x00", "")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")


async def run_blocking(
    argv: list[str],
    *,
    timeout: float = 300,
    stdin: bytes | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run a blocking subprocess off the event loop, capturing output.

    Centralises what every shell-out site needs: ``asyncio.to_thread`` (works on
    any event-loop policy — unlike ``create_subprocess_exec`` on a Windows
    SelectorEventLoop) plus ``creationflags=NO_WINDOW`` to hide the console flash.
    Does not raise on non-zero exit — the caller inspects ``.returncode`` — but
    propagates ``FileNotFoundError`` / ``TimeoutExpired`` / ``OSError`` for the
    caller's own error mapping.
    """
    return await asyncio.to_thread(
        subprocess.run,
        argv,
        input=stdin,
        cwd=cwd,
        capture_output=True,
        timeout=timeout,
        creationflags=NO_WINDOW,
        env=env,
    )


async def run_capture(
    argv: list[str],
    *,
    timeout: float = 60,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> tuple[int, str, str]:
    """Run a command and return ``(returncode, stdout, stderr)`` decoded leniently.

    Maps the usual spawn failures to conventional shell codes: 127 (not found),
    124 (timeout), 1 (other OSError). Shared by the WSL/PowerShell probe + install
    helpers, which previously each carried an identical copy of this block.
    """
    try:
        result = await run_blocking(argv, timeout=timeout, env=env, cwd=cwd)
    except FileNotFoundError:
        return 127, "", f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except OSError as exc:
        return 1, "", str(exc)
    return result.returncode, decode_loose(result.stdout), decode_loose(result.stderr)
