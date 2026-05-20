"""Bash tool — executes commands inside the WSL sandbox, with PowerShell fallback."""

from __future__ import annotations

import asyncio
import shutil
import subprocess

from agent.sandbox import SandboxPolicy
from tools.base import BaseTool, ToolDefinition, ToolSchema

# Hide the Windows console window for spawned wsl.exe / powershell.exe — no
# flash on each call.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class BashTool(BaseTool):
    """Execute a shell command. Default = bash inside WSL; falls back to
    Windows PowerShell when WSL is unavailable or the user forced PowerShell
    mode in Settings."""

    name = "bash_tool"
    _DESC_WSL = (
        "Execute a bash command inside WSL. "
        "Use this to run shell commands, scripts, git, Python, etc. "
        "The command runs inside the default WSL distribution, "
        "with cwd set to the current chat's working folder. "
        "$USER and $USER_HOME are pre-set environment variables."
    )
    _DESC_PS = (
        "Execute a Windows PowerShell command. WSL is not available on this "
        "machine, so commands run via powershell.exe in the current chat's "
        "working folder. Use PowerShell syntax (Get-ChildItem, $env:VAR, "
        "Set-Location, backtick line continuation). `&&` is not available — "
        "use `;` or `if ($?) { ... }` to chain."
    )
    description = _DESC_WSL

    def __init__(self, user_name: str, user_home: str | None = None, shell: str = "wsl") -> None:
        self._user_name = user_name
        self._user_home = user_home or f"/home/{user_name}"
        # Set per-request from api/chat.py. Default policy = no chat dir, no
        # cage, no blocks — equivalent to unrestricted, used only before the
        # first chat request lands.
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True, shell=shell)
        self._shell = shell

    def set_policy(self, policy: SandboxPolicy) -> None:
        """Install the per-chat sandbox policy. The policy carries the shell
        kind so wrap_bash / wrap_powershell are picked correctly."""
        self._policy = policy
        self._shell = policy.shell

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self._DESC_PS if self._shell == "powershell" else self._DESC_WSL,
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": (
                                "The PowerShell command to execute."
                                if self._shell == "powershell"
                                else "The bash command to execute inside WSL."
                            ),
                        }
                    },
                    "required": ["command"],
                },
            )
        )

    async def execute(self, command: str) -> str:
        """Dispatch to bash-in-WSL or PowerShell based on the active shell.

        Two auto-fallback layers for "wsl" mode:
          1. wsl.exe missing from PATH → PowerShell.
          2. WSL spawns but reports "no installed distributions" or similar
             setup failure → PowerShell (one retry).
        Keeps the chat working when the user couldn't finish the WSL install.
        """
        shell = self._shell
        ps_present = shutil.which("powershell") is not None or shutil.which("pwsh") is not None

        if shell == "wsl" and shutil.which("wsl") is None and ps_present:
            shell = "powershell"

        if shell == "powershell":
            return await self._exec_powershell(command)

        wsl_out = await self._exec_wsl(command)
        if ps_present and _looks_like_wsl_setup_failure(wsl_out):
            ps_out = await self._exec_powershell(command)
            return (
                "[bash_tool] WSL не настроен (нет рабочего дистрибутива). "
                "Команда перезапущена в PowerShell — настройте WSL или переключитесь "
                "на PowerShell в Settings → Терминал.\n\n" + ps_out
            )
        return wsl_out

    async def _exec_wsl(self, command: str) -> str:
        # Outer envelope sets USER/USER_HOME/HOME — these are inherited into
        # the bwrap sandbox via --setenv, but we also keep them on the outer
        # shell for backwards compatibility with any tool that bypasses
        # wrap_bash (e.g. wsl_run helpers in agent/wsl_exec.py).
        inner = self._policy.wrap_bash(command)
        full_cmd = (
            f"export USER='{self._user_name}' "
            f"USER_HOME='{self._user_home}' "
            f"HOME='{self._user_home}'; {inner}"
        )
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["wsl.exe", "bash", "-c", full_cmd],
                capture_output=True,
                timeout=300,
                creationflags=_NO_WINDOW,
            )
        except FileNotFoundError:
            return (
                "[bash_tool error] wsl.exe not found in PATH — install WSL "
                "(Settings → Терминал) or switch to PowerShell mode."
            )
        except subprocess.TimeoutExpired:
            return "[bash_tool error] command timed out after 300s."
        except OSError as exc:
            return f"[bash_tool error] failed to spawn wsl.exe: {exc}"

        return _format_result(result)

    async def _exec_powershell(self, command: str) -> str:
        inner = self._policy.wrap_powershell(command)
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", inner],
                capture_output=True,
                timeout=300,
                creationflags=_NO_WINDOW,
            )
        except FileNotFoundError:
            return "[bash_tool error] powershell.exe not found in PATH."
        except subprocess.TimeoutExpired:
            return "[bash_tool error] command timed out after 300s."
        except OSError as exc:
            return f"[bash_tool error] failed to spawn powershell.exe: {exc}"

        return _format_result(result)


def _looks_like_wsl_setup_failure(output: str) -> bool:
    """Heuristic: WSL is on PATH but has no working distro.

    wsl.exe emits UTF-16-encoded messages like "Windows Subsystem for Linux has
    no installed distributions" — by the time we read the bytes, the NULs are
    interleaved into the decoded string. Strip them before matching.
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


def _format_result(result: subprocess.CompletedProcess[bytes]) -> str:
    out = result.stdout.decode("utf-8", errors="replace")
    err = result.stderr.decode("utf-8", errors="replace")
    parts: list[str] = []
    if out.strip():
        parts.append(out.strip())
    if err.strip():
        parts.append(f"[stderr]\n{err.strip()}")
    if result.returncode != 0:
        parts.append(f"[exit code: {result.returncode}]")
    return "\n".join(parts) if parts else "(no output)"
