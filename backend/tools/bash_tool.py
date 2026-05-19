"""Bash tool — executes commands inside the WSL sandbox."""

from __future__ import annotations

import asyncio
import shlex
import subprocess

from tools.base import BaseTool, ToolDefinition, ToolSchema


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
        # Set per-request from api/chat.py. Empty string = no cd, command runs
        # from wherever wsl.exe drops you (default: %USERPROFILE% mapped via /mnt).
        self._cwd: str = ""

    def set_cwd(self, cwd: str) -> None:
        """Set the working directory for the next execute() call.

        Single-user assumption: there's no concurrent chat from this process.
        Setting cwd globally on the tool instance is fine for now.
        """
        self._cwd = cwd

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
        """Run a command via wsl.exe with user env vars, return stdout+stderr.

        Uses blocking subprocess.run inside asyncio.to_thread to avoid
        asyncio.create_subprocess_exec, which raises NotImplementedError on
        Windows SelectorEventLoop (the loop uvicorn sometimes picks).
        """
        cd_prefix = ""
        if self._cwd:
            cwd_q = shlex.quote(self._cwd)
            cd_prefix = f"mkdir -p {cwd_q} && cd {cwd_q} && "
        full_cmd = (
            f"export USER='{self._user_name}' "
            f"USER_HOME='{self._user_home}' "
            f"HOME='{self._user_home}'; {cd_prefix}{command}"
        )
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["wsl.exe", "bash", "-c", full_cmd],
                capture_output=True,
                timeout=300,
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
