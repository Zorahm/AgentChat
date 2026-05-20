"""Per-chat sandbox policy.

Three rules:
  1. bash_tool runs inside a bubblewrap (bwrap) cage that exposes only the
     chat directory read-write plus read-only system paths (/usr, /bin, /lib,
     /etc). The model cannot read $HOME, /mnt, or anything outside the cage.
  2. read_file is open by default but rejects anything under AgentChat's
     own settings/database directory (the .agents folder).
  3. write_file and the <file>/<edit> stream tags only accept paths inside
     the chat directory.

The ``unrestricted`` flag in SettingsData disables all three checks — that's
the user-facing escape hatch for power users.
"""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from pathlib import PurePosixPath


@dataclass(frozen=True)
class SandboxPolicy:
    """One policy per chat request, built in api/chat.py."""

    chat_dir: str = ""  # WSL absolute path; empty = no per-chat folder
    blocked_read_prefixes: tuple[str, ...] = field(default_factory=tuple)
    user_name: str = ""
    unrestricted: bool = False

    # ── reads ─────────────────────────────────────────────────────────

    def check_read(self, path: str) -> str | None:
        """Return an error message if reading *path* is forbidden, else None."""
        if self.unrestricted:
            return None
        norm = _normalize(path)
        for blocked in self.blocked_read_prefixes:
            if _is_under(norm, _normalize(blocked)):
                return (
                    f"Sandbox: чтение из системной папки агента запрещено ({path}). "
                    "Включи 'Unrestricted mode' в Settings, если правда нужно."
                )
        return None

    # ── writes ────────────────────────────────────────────────────────

    def check_write(self, path: str) -> str | None:
        """Return an error message if writing to *path* is forbidden, else None."""
        if self.unrestricted:
            return None
        if not self.chat_dir:
            return (
                "Sandbox: нет рабочей папки чата (chat_dir_slug отсутствует). "
                "Создай новый чат или включи 'Unrestricted mode'."
            )
        # Only WSL absolute paths allowed in restricted mode. Anything else
        # (Windows paths, relative paths) is rejected outright.
        if not path.startswith("/"):
            return (
                f"Sandbox: запись разрешена только в папку чата ({self.chat_dir}). "
                f"Путь '{path}' не WSL-абсолютный."
            )
        if not _is_under(_normalize(path), _normalize(self.chat_dir)):
            return (
                f"Sandbox: запись разрешена только в {self.chat_dir}; путь '{path}' "
                "за пределами. Включи 'Unrestricted mode' для произвольных записей."
            )
        return None

    # ── bash wrap ─────────────────────────────────────────────────────

    def wrap_bash(self, inner_cmd: str) -> str:
        """Return *inner_cmd* wrapped in a bwrap call, or the cmd unchanged
        when unrestricted.

        The wrapper checks bwrap availability at runtime and falls back to a
        loud error so the model doesn't silently break out.
        """
        if self.unrestricted:
            # No cage: just cd into chat_dir if known, else run raw.
            if self.chat_dir:
                cwd_q = shlex.quote(self.chat_dir)
                return f"mkdir -p {cwd_q} && cd {cwd_q} && {inner_cmd}"
            return inner_cmd

        if not self.chat_dir:
            # Restricted but no chat anchor — refuse instead of running uncaged.
            return (
                "echo '[sandbox] no chat working directory; cannot run bash in "
                "restricted mode. Create a chat or toggle Unrestricted mode.' >&2; "
                "exit 126"
            )

        chat_q = shlex.quote(self.chat_dir)
        # Build the bwrap argv as a single bash command. Read-only system
        # mounts give the model access to all installed tools (python, node,
        # git, etc.) without letting it modify them. /tmp is a private tmpfs.
        # HOME points at chat_dir so `pip install --user`, `npm config`, etc.
        # land inside the chat folder instead of leaking to the host $HOME.
        bwrap_args = [
            "bwrap",
            # WIPE inherited env first, then re-add only the safe vars below.
            # Without --clearenv the cage inherits OPENAI_API_KEY / ANTHROPIC_API_KEY
            # / etc. from backend.exe — the model could exfil them via `echo $...`
            # or `env`. LD_PRELOAD from outer env is also nullified here.
            "--clearenv",
            "--ro-bind", "/usr", "/usr",
            "--ro-bind", "/bin", "/bin",
            "--ro-bind", "/sbin", "/sbin",
            "--ro-bind", "/lib", "/lib",
            "--ro-bind-try", "/lib64", "/lib64",
            "--ro-bind", "/etc", "/etc",
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--tmpfs", "/run",
            "--bind", self.chat_dir, self.chat_dir,
            "--chdir", self.chat_dir,
            "--setenv", "HOME", self.chat_dir,
            "--setenv", "USER", self.user_name or "user",
            "--setenv", "LOGNAME", self.user_name or "user",
            "--setenv", "SHELL", "/bin/bash",
            "--setenv", "TERM", "xterm-256color",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "LC_ALL", "C.UTF-8",
            "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "--unshare-user-try",
            "--unshare-ipc",
            "--unshare-pid",
            "--unshare-uts",
            "--unshare-cgroup-try",
            "--share-net",
            "--die-with-parent",
            "--new-session",
            "bash", "-c", inner_cmd,
        ]
        bwrap_str = " ".join(shlex.quote(a) for a in bwrap_args)
        # If bwrap is not installed, fall through to a friendly error rather
        # than silently dropping the cage. `command -v` returns non-zero → we
        # print the install hint and exit 127.
        fallback = (
            "echo '[sandbox] bubblewrap (bwrap) is not installed in WSL. "
            "Install it with: sudo apt update && sudo apt install -y bubblewrap. "
            "Or toggle Unrestricted mode in Settings.' >&2; exit 127"
        )
        return f"mkdir -p {chat_q}; if command -v bwrap >/dev/null 2>&1; then {bwrap_str}; else {fallback}; fi"


# ── helpers ───────────────────────────────────────────────────────────


def _normalize(path: str) -> str:
    """Normalize a path for prefix comparison.

    Posix-style paths are normalised via PurePosixPath. Windows-style paths
    are normalised via os.path.normpath and lowercased (Windows is case-
    insensitive). The two namespaces never overlap, so this is enough to
    block lookups in both at once.
    """
    if not path:
        return ""
    if path.startswith("/"):
        return str(PurePosixPath(path))
    return os.path.normpath(path).lower()


def _is_under(child: str, parent: str) -> bool:
    """True iff *child* is *parent* or a descendant of it."""
    if not parent:
        return False
    if child == parent:
        return True
    sep = "/" if parent.startswith("/") else os.sep
    if not parent.endswith(sep):
        parent_with_sep = parent + sep
    else:
        parent_with_sep = parent
    return child.startswith(parent_with_sep)


def windows_to_wsl(win_path: str) -> str | None:
    """Translate ``C:\\foo\\bar`` to ``/mnt/c/foo/bar``. Returns None if not a
    Windows drive path."""
    if len(win_path) < 2 or win_path[1] != ":":
        return None
    drive = win_path[0].lower()
    rest = win_path[2:].replace("\\", "/")
    if rest.startswith("/"):
        rest = rest[1:]
    return f"/mnt/{drive}/{rest}" if rest else f"/mnt/{drive}"
