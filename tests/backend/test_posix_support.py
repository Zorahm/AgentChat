"""Tests for native POSIX (Linux/macOS) support — the third shell mode.

These exercise the platform branches without requiring an actual Linux host:
``sys.platform`` and ``host_exec.IS_POSIX`` are monkeypatched so the POSIX code
paths run (and, for file IO, hit the real local filesystem) even on Windows CI.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import agent.host_exec as host_exec  # noqa: E402
import agent.posix_exec as posix_exec  # noqa: E402
import shell  # noqa: E402
from agent.sandbox import SandboxPolicy  # noqa: E402
from tools.bash_tool import BashTool  # noqa: E402

POSIX_CHAT_DIR = "/home/user/AgentChat/chats/chat-abcd-20260601-1200"


# ── resolve_active_shell ───────────────────────────────────────────────


def test_resolve_active_shell_is_posix_on_non_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    # Every non-zsh preference collapses to "posix" — WSL/PowerShell are
    # Windows-only concepts.
    assert shell.resolve_active_shell("auto") == "posix"
    assert shell.resolve_active_shell("wsl") == "posix"
    assert shell.resolve_active_shell("powershell") == "posix"


def test_resolve_active_shell_honours_zsh_on_non_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    # An explicit zsh preference is the one native opt-in: bash_tool spawns zsh.
    assert shell.resolve_active_shell("zsh") == "zsh"


def test_resolve_active_shell_ignores_zsh_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shell, "wsl_available", lambda: True)
    # zsh is not a Windows shell — it falls through to the auto resolution.
    assert shell.resolve_active_shell("zsh") == "wsl"


def test_resolve_active_shell_honours_forced_modes_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert shell.resolve_active_shell("wsl") == "wsl"
    assert shell.resolve_active_shell("powershell") == "powershell"


# ── host_exec native file IO (POSIX branch) ─────────────────────────────


@pytest.mark.asyncio
async def test_native_write_then_read_roundtrip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(host_exec, "IS_POSIX", True)
    target = tmp_path / "nested" / "out.txt"

    await host_exec.host_write_bytes(str(target), b"hello")

    assert target.read_bytes() == b"hello"  # parent dir auto-created
    assert await host_exec.host_read_text(str(target)) == "hello"
    assert await host_exec.host_read_bytes(str(target)) == b"hello"


@pytest.mark.asyncio
async def test_native_write_append(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(host_exec, "IS_POSIX", True)
    target = tmp_path / "log.txt"

    await host_exec.host_write_bytes(str(target), b"a")
    await host_exec.host_write_bytes(str(target), b"b", append=True)

    assert await host_exec.host_read_text(str(target)) == "ab"


@pytest.mark.asyncio
async def test_native_read_missing_raises_filenotfound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(host_exec, "IS_POSIX", True)
    with pytest.raises(FileNotFoundError):
        await host_exec.host_read_text(str(tmp_path / "does-not-exist.txt"))


# ── SandboxPolicy in posix mode ────────────────────────────────────────


def test_posix_wrap_bash_uses_bwrap_not_powershell() -> None:
    policy = SandboxPolicy(chat_dir=POSIX_CHAT_DIR, shell="posix")
    wrapped = policy.wrap_bash("echo hi")
    # Same bwrap cage as WSL mode — not the soft PowerShell prefix.
    assert "bwrap" in wrapped
    assert "Set-Location" not in wrapped
    # posix cage runs the command through bash.
    assert "bash -c" in wrapped


def test_zsh_wrap_bash_cage_runs_zsh() -> None:
    policy = SandboxPolicy(chat_dir=POSIX_CHAT_DIR, shell="zsh")
    wrapped = policy.wrap_bash("echo hi")
    assert "bwrap" in wrapped
    # The cage's inner interpreter is zsh, not bash, when zsh is the shell.
    assert "zsh -c" in wrapped


def test_posix_check_write_allows_inside_rejects_outside() -> None:
    policy = SandboxPolicy(chat_dir=POSIX_CHAT_DIR, shell="posix")
    assert policy.check_write(f"{POSIX_CHAT_DIR}/result.txt") is None
    # A Windows-style absolute path is the wrong namespace on a POSIX host.
    assert policy.check_write("C:\\Windows\\System32\\x") is not None
    # A real POSIX path outside the chat dir is refused.
    assert policy.check_write("/etc/passwd") is not None


def test_posix_check_read_allows_uploads_rejects_system() -> None:
    policy = SandboxPolicy(chat_dir=POSIX_CHAT_DIR, shell="posix")
    assert policy.check_read(f"{POSIX_CHAT_DIR}/uploads/a.txt") is None
    assert policy.check_read("/etc/passwd") is not None


# ── macOS sandbox-exec fallback ────────────────────────────────────────


def test_wrap_bash_falls_back_to_sandbox_exec() -> None:
    policy = SandboxPolicy(chat_dir=POSIX_CHAT_DIR, shell="posix")
    wrapped = policy.wrap_bash("echo hi")
    # Runtime dispatch: bwrap first, then the macOS Seatbelt cage, then the
    # loud exit-127 error — never a silent uncaged run.
    assert "command -v bwrap" in wrapped
    assert "/usr/bin/sandbox-exec" in wrapped
    assert "exit 127" in wrapped
    # --clearenv parity: env is rebuilt from scratch so backend API keys never
    # reach the model's shell; HOME points at the chat dir.
    assert "/usr/bin/env -i" in wrapped
    assert f"HOME={POSIX_CHAT_DIR}" in wrapped


def test_sandbox_exec_profile_denies_writes_and_home_reads() -> None:
    policy = SandboxPolicy(
        chat_dir=POSIX_CHAT_DIR,
        allowed_read_prefixes=("/home/user/.agents",),
        shell="posix",
    )
    wrapped = policy.wrap_bash("echo hi")
    assert "(deny file-write*)" in wrapped
    assert f'(subpath "{POSIX_CHAT_DIR}")' in wrapped
    # The real home is derived from the app's <home>/AgentChat/chats/<slug>
    # layout and denied for reads (bwrap's unmounted-home parity)...
    assert '(deny file-read* (subpath "/home/user"))' in wrapped
    # ...with the skill allowlist re-allowed back on top.
    assert '(subpath "/home/user/.agents")' in wrapped


def test_sandbox_exec_cage_runs_zsh_when_chosen() -> None:
    policy = SandboxPolicy(chat_dir=POSIX_CHAT_DIR, shell="zsh")
    wrapped = policy.wrap_bash("echo hi")
    # The Seatbelt cage's inner interpreter follows the shell preference too.
    assert "/bin/zsh -c" in wrapped


# ── BashTool dispatch in posix mode ────────────────────────────────────


def test_bash_tool_posix_definition_advertises_local_bash() -> None:
    tool = BashTool(user_name="user", user_home="/home/user", shell="posix")
    definition = tool.get_definition()
    assert "local machine" in definition.function.description


def test_bash_tool_zsh_definition_advertises_zsh() -> None:
    tool = BashTool(user_name="user", user_home="/home/user", shell="zsh")
    definition = tool.get_definition()
    assert "zsh" in definition.function.description


@pytest.mark.asyncio
@pytest.mark.parametrize("shell_mode", ["posix", "zsh"])
async def test_bash_tool_native_execute_routes_to_native(
    monkeypatch: pytest.MonkeyPatch, shell_mode: str
) -> None:
    tool = BashTool(user_name="user", user_home="/home/user", shell=shell_mode)
    seen: dict[str, str] = {}

    async def fake_exec_native(command: str) -> str:
        seen["command"] = command
        return "native-ok"

    monkeypatch.setattr(tool, "_exec_native", fake_exec_native)
    out = await tool.execute("echo hi")

    assert out == "native-ok"
    assert seen["command"] == "echo hi"


# ── host_tool_env — strip AppImage/PyInstaller lib pollution ────────────


def test_host_tool_env_strips_bundle_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    # An AppImage prepends $APPDIR/usr/lib to LD_LIBRARY_PATH; a spawned bash
    # would otherwise load the bundled (mismatched) libreadline and die.
    monkeypatch.setenv("APPDIR", "/tmp/.mount_AgentXY")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/.mount_AgentXY/usr/lib:/usr/lib")
    env = posix_exec.host_tool_env()
    assert env is not None
    # Bundle path dropped, the genuine host path kept.
    assert env["LD_LIBRARY_PATH"] == "/usr/lib"


def test_host_tool_env_drops_var_when_all_bundle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APPDIR", "/tmp/.mount_AgentXY")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/.mount_AgentXY/usr/lib")
    monkeypatch.delenv("LD_PRELOAD", raising=False)
    env = posix_exec.host_tool_env()
    assert env is not None
    assert "LD_LIBRARY_PATH" not in env


def test_host_tool_env_none_when_clean(monkeypatch: pytest.MonkeyPatch) -> None:
    # No LD_* pollution → None, so subprocess.run(env=None) just inherits.
    monkeypatch.delenv("LD_LIBRARY_PATH", raising=False)
    monkeypatch.delenv("LD_PRELOAD", raising=False)
    monkeypatch.delenv("PYTHONHOME", raising=False)
    monkeypatch.delenv("PYTHONPATH", raising=False)
    monkeypatch.delenv("APPDIR", raising=False)
    assert posix_exec.host_tool_env() is None


def test_host_tool_env_strips_pythonhome(monkeypatch: pytest.MonkeyPatch) -> None:
    # The AppImage runtime points PYTHONHOME/PYTHONPATH at its own mounted
    # usr/ tree. Left in place, a spawned system python3 (e.g. the
    # `python3 -m venv` chats.py runs per chat) fails at startup with
    # "ModuleNotFoundError: No module named 'encodings'" because it looks for
    # its stdlib inside the (unrelated) bundle layout instead of its own.
    monkeypatch.setenv("APPDIR", "/tmp/.mount_AgentXY")
    monkeypatch.setenv("PYTHONHOME", "/tmp/.mount_AgentXY/usr/")
    monkeypatch.setenv("PYTHONPATH", "/tmp/.mount_AgentXY/usr/share/pyshared/")
    env = posix_exec.host_tool_env()
    assert env is not None
    assert "PYTHONHOME" not in env
    assert "PYTHONPATH" not in env
