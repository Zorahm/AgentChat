"""Per-chat sandbox policy.

Three rules:
  1. bash_tool runs inside a bubblewrap (bwrap) cage that exposes only the
     chat directory read-write plus read-only system paths (/usr, /bin, /lib,
     /etc). The model cannot read $HOME, /mnt, or anything outside the cage.
  2. read_file is restricted to ``chat_dir`` — i.e. files the user has
     attached via @-mention (which land under ``chat_dir/uploads/``) plus
     anything the model itself created through <file>. Reading arbitrary
     filesystem paths is forbidden so the model can't scan ``~/.ssh``,
     ``/etc``, AppData, or the rest of the host. Explicit allowlist prefixes
     can grant read-only access to shared agent resources such as ``~/.agents``.
  3. write_file and the <file>/<edit> stream tags only accept paths inside
     the chat directory.

The ``unrestricted`` flag in SettingsData disables all three checks — that's
the user-facing escape hatch for power users.
"""

from __future__ import annotations

import os
import posixpath
import shlex
from dataclasses import dataclass, field




@dataclass(frozen=True)
class SandboxPolicy:
    """One policy per chat request, built in api/chat.py."""

    chat_dir: str = ""  # absolute path; WSL form for shell="wsl", Windows for "powershell"
    blocked_read_prefixes: tuple[str, ...] = field(default_factory=tuple)
    allowed_read_prefixes: tuple[str, ...] = field(default_factory=tuple)
    user_name: str = ""
    unrestricted: bool = False
    # Which terminal the bash_tool envelope wraps. PowerShell has no bwrap
    # equivalent — restricted mode falls back to "soft" sandboxing (cd into
    # chat_dir, no kernel-level isolation) and the user sees a warning.
    shell: str = "wsl"

    # ── reads ─────────────────────────────────────────────────────────

    def check_read(self, path: str) -> str | None:
        """Return an error message if reading *path* is forbidden, else None.

        In restricted mode the rule is allowlist-style: the path must be
        inside ``chat_dir``. That gives the model access to attached files
        (``chat_dir/uploads/*``) and files it created itself, and nothing
        else. The blocklist is checked first as defense in depth in case a
        future bug ever lets chat_dir overlap with internal app storage.
        """
        if self.unrestricted:
            return None

        norm = _normalize(path)

        # Belt-and-braces: reject the settings/db directory even if it
        # somehow sits inside the configured chat_dir.
        for blocked in self.blocked_read_prefixes:
            if _is_under(norm, _normalize(blocked)):
                return (
                    f"Sandbox: чтение из системной папки агента запрещено ({path}). "
                    "Включи 'Unrestricted mode' в Settings, если правда нужно."
                )

        for allowed in self.allowed_read_prefixes:
            if _is_under(norm, _normalize(allowed)):
                return None

        if not self.chat_dir:
            return (
                "Sandbox: чтение запрещено — для этого чата нет рабочей папки. "
                "Создай новый чат или включи 'Unrestricted mode' в Settings."
            )

        # Path-namespace check: a Windows path in WSL mode (or vice versa)
        # never matches chat_dir under _is_under, so we'd land in the
        # generic "outside chat folder" branch — but the user-facing error
        # is nicer if we call out the mismatch directly.
        chat_is_posix = self.chat_dir.startswith("/")
        path_is_posix = path.startswith("/")
        if chat_is_posix != path_is_posix:
            return (
                f"Sandbox: путь '{path}' в чужой ФС — текущая папка чата "
                f"{self.chat_dir}. Прикрепи файл через @-меню."
            )

        if not _is_under(norm, _normalize(self.chat_dir)):
            return (
                f"Sandbox: read_file разрешён только внутри папки чата "
                f"({self.chat_dir}). Файл '{path}' за её пределами. "
                "Чтобы дать модели доступ к файлу с диска — прикрепи его "
                "через @-меню в чате (тогда он окажется в uploads/). "
                "Альтернатива — включить 'Unrestricted mode' в Settings."
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
        # Path must be absolute in the matching namespace: WSL ("/…") for the
        # bash shell, Windows drive letter for PowerShell. Anything else is
        # rejected outright.
        if self.shell == "powershell":
            if not (len(path) >= 3 and path[1] == ":" and path[2] in ("\\", "/")):
                return (
                    f"Sandbox: запись разрешена только в папку чата ({self.chat_dir}). "
                    f"Путь '{path}' не Windows-абсолютный."
                )
        else:
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
        path_entries = [
            f"{self.chat_dir}/.venv/bin",
            "/usr/local/sbin",
            "/usr/local/bin",
            "/usr/sbin",
            "/usr/bin",
            "/sbin",
            "/bin",
        ]
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
            "--setenv",
            "PATH",
            ":".join(path_entries),
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

    # ── powershell wrap ───────────────────────────────────────────────

    def wrap_powershell(self, inner_cmd: str) -> str:
        """Return *inner_cmd* prefixed with a chat-dir Set-Location.

        PowerShell on Windows has no bwrap equivalent, so the restricted mode
        is "soft": we only ensure the cwd is the chat folder. The model can
        still resolve absolute Windows paths, but the file-write tools refuse
        anything outside chat_dir, so writes stay contained. The user is told
        in Settings that PowerShell mode disables the kernel-level cage.
        """
        if not self.chat_dir:
            return inner_cmd
        # PowerShell single-quoted strings escape ' as ''. Avoid quoting the
        # entire inner command (it may already contain quotes); just guard the
        # path.
        ps_path = self.chat_dir.replace("'", "''")
        prefix = (
            f"$d = '{ps_path}'; "
            f"if (-not (Test-Path -LiteralPath $d)) {{ "
            f"New-Item -ItemType Directory -Force -Path $d | Out-Null }}; "
            f"Set-Location -LiteralPath $d; "
        )
        return prefix + inner_cmd


# ── helpers ───────────────────────────────────────────────────────────


def _normalize(path: str) -> str:
    """Normalize a path for prefix comparison.

    Critically, this collapses ``..`` and ``.`` segments LEXICALLY so that
    paths like ``/home/x/chat/uploads/../../etc/passwd`` resolve to
    ``/etc/passwd`` before the chat_dir prefix check runs. Without this,
    the sandbox is bypassable via a literal-prefix-but-traversed path.

    Posix-style paths use ``posixpath.normpath``. Windows-style paths use
    ``os.path.normpath`` (which on Windows collapses both ``..`` and
    backslash variants) and are then lowercased — Windows is case-
    insensitive. The two namespaces never overlap, so this is enough to
    block lookups in both at once.
    """
    if not path:
        return ""
    if path.startswith("/"):
        return posixpath.normpath(path)
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
