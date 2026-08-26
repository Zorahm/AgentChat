"""Bash tool — executes commands inside the WSL sandbox, with PowerShell fallback."""

from __future__ import annotations

from agent.sandbox import SandboxPolicy
from tools.arg_coerce import clamp_int
from tools.base import BaseTool, ToolDefinition, ToolSchema
from tools.output_budget import MAX_TOOL_OUTPUT_CHARS, clamp_output
from tools.shell_exec import ShellResult, run_in_shell

# Wall-clock ceiling for one command. The default suits the overwhelming
# majority (a build, a script, a git operation); the model can raise it per call
# for a long install and lower it for something that might hang.
DEFAULT_TIMEOUT = 300
MAX_TIMEOUT = 600

# stderr rarely carries the answer but often carries the reason, so it gets its
# own slice of the budget instead of competing with stdout for one.
_STDERR_BUDGET = MAX_TOOL_OUTPUT_CHARS // 4


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
    _DESC_POSIX = (
        "Execute a bash command on the local machine. "
        "Use this to run shell commands, scripts, git, Python, etc., "
        "with cwd set to the current chat's working folder. "
        "$USER and $USER_HOME are pre-set environment variables."
    )
    _DESC_ZSH = (
        "Execute a zsh command on the local machine. "
        "Use this to run shell commands, scripts, git, Python, etc., "
        "with cwd set to the current chat's working folder. "
        "This is zsh, not bash — avoid bash-only syntax. "
        "$USER and $USER_HOME are pre-set environment variables."
    )
    # Appended to whichever shell dialect applies: the parts that are true of
    # every one of them, and that the model needs in order to write a command
    # that fits (rather than discovering the cap from a clipped result).
    _DESC_COMMON = (
        f" Output is capped at ~{MAX_TOOL_OUTPUT_CHARS} characters — the middle is "
        "cut out of anything longer, so pipe through head/tail/grep, or redirect "
        "to a file and read it back, instead of printing something large."
    )
    description = _DESC_WSL + _DESC_COMMON

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
        if self._shell == "powershell":
            desc = self._DESC_PS
            cmd_desc = "The PowerShell command to execute."
        elif self._shell == "zsh":
            desc = self._DESC_ZSH
            cmd_desc = "The zsh command to execute on the local machine."
        elif self._shell == "posix":
            desc = self._DESC_POSIX
            cmd_desc = "The bash command to execute on the local machine."
        else:
            desc = self._DESC_WSL
            cmd_desc = "The bash command to execute inside WSL."
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=desc + self._DESC_COMMON,
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": cmd_desc,
                        },
                        "timeout": {
                            "type": "integer",
                            "description": (
                                f"Seconds to wait before killing the command "
                                f"(default {DEFAULT_TIMEOUT}, max {MAX_TIMEOUT}). "
                                "Raise it for a long install or build; lower it for "
                                "something that might hang."
                            ),
                        },
                    },
                    "required": ["command"],
                },
            )
        )

    async def execute(self, command: str, timeout: int = DEFAULT_TIMEOUT) -> str:
        """Run *command* and render what it produced.

        The dispatch, the sandbox envelope and the two WSL fallbacks all live in
        :mod:`tools.shell_exec`, shared with ``grep``. What stays here is the
        part that is specific to handing a command's output to a model: the
        timeout ceiling, the output budget, and the two markers
        (:mod:`agent.tool_outcome`) that tell the loop this call failed.
        """
        secs = _clamp_timeout(timeout)
        result = await run_in_shell(
            command,
            policy=self._policy,
            user_name=self._user_name,
            user_home=self._user_home,
            timeout=secs,
        )
        if result.error:
            return self._error_text(result.error, secs)
        return _format_result(result)

    def _error_text(self, error: str, timeout: int) -> str:
        """Turn "no process ran" into something the model can act on."""
        if error.startswith("timed out"):
            return _timeout_message(timeout)
        if error.startswith("wsl.exe not found"):
            error = (
                "wsl.exe not found in PATH — install WSL (Settings → Shell) or "
                "switch to PowerShell mode."
            )
        elif error.startswith("zsh not found"):
            error = (
                "zsh not found in PATH — install zsh or switch the shell to bash "
                "in Settings → Terminal."
            )
        return f"[bash_tool error] {error}"


def _clamp_timeout(timeout: object) -> int:
    """Coerce a model-supplied timeout into 1..MAX_TIMEOUT seconds."""
    return clamp_int(timeout, fallback=DEFAULT_TIMEOUT, low=1, high=MAX_TIMEOUT)


def _timeout_message(timeout: int) -> str:
    """Say what the limit was and how to get past it — a bare "timed out" leaves
    the model guessing whether to retry the same command unchanged."""
    raise_it = (
        f" Pass a larger `timeout` (up to {MAX_TIMEOUT}) if the command genuinely "
        "needs longer."
        if timeout < MAX_TIMEOUT
        else f" {MAX_TIMEOUT}s is the ceiling — run it in the background and poll, "
        "or split the work."
    )
    return f"[bash_tool error] command timed out after {timeout}s.{raise_it}"


def _format_result(result: ShellResult) -> str:
    out = result.stdout
    err = result.stderr
    parts: list[str] = []
    if result.notice:
        parts.append(f"[bash_tool] {result.notice}\n")
    # Clamped per stream rather than once at the end, so a flood of stdout can
    # never push the [stderr] block or the exit code out of the result — those
    # two are what the model needs most when a command went wrong.
    if out.strip():
        parts.append(clamp_output(out.strip()))
    if err.strip():
        parts.append(f"[stderr]\n{clamp_output(err.strip(), limit=_STDERR_BUDGET)}")
    if result.returncode != 0:
        parts.append(f"[exit code: {result.returncode}]")
    return "\n".join(parts) if parts else "(no output)"
