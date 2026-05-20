"""Bash tool — executes commands inside the WSL sandbox."""

from __future__ import annotations

import asyncio
import subprocess

from agent.sandbox import SandboxPolicy
from tools.base import BaseTool, ToolDefinition, ToolSchema

# Hide the Windows console window for spawned wsl.exe — no flash on each call.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class BashTool(BaseTool):
    """Execute a bash command inside WSL (Windows Subsystem for Linux)."""

    name = "bash_tool"
    description = (
        "Execute a bash command inside WSL. "
        "Use this to run shell commands, scripts, git, Python, etc. "
        "The command runs inside the default WSL distribution, "
        "with cwd set to the current chat's working folder. "
        "$USER and $USER_HOME are pre-set environment variables."
    )

    def __init__(self, user_name: str, user_home: str | None = None) -> None:
        self._user_name = user_name
        self._user_home = user_home or f"/home/{user_name}"
        # Set per-request from api/chat.py. Default policy = no chat dir, no
        # cage, no blocks — equivalent to unrestricted, used only before the
        # first chat request lands.
        self._policy: SandboxPolicy = SandboxPolicy(unrestricted=True)

    def set_policy(self, policy: SandboxPolicy) -> None:
        """Install the per-chat sandbox policy. Single-user assumption — there's
        no concurrent chat from this process, so storing it on the instance
        is fine."""
        self._policy = policy

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The bash command to execute inside WSL.",
                        }
                    },
                    "required": ["command"],
                },
            )
        )

    async def execute(self, command: str) -> str:
        """Run a command via wsl.exe, return stdout+stderr.

        The command is wrapped by the SandboxPolicy: in restricted mode the
        wrapper invokes bwrap to confine the process to the chat directory;
        in unrestricted mode it simply cds into the chat dir (or runs raw).
        """
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
            return "[bash_tool error] wsl.exe not found in PATH — install WSL or check $PATH."
        except subprocess.TimeoutExpired:
            return "[bash_tool error] command timed out after 300s."
        except OSError as exc:
            return f"[bash_tool error] failed to spawn wsl.exe: {exc}"

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
