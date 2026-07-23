"""Per-chat sandbox policy.

Three rules:
  1. bash_tool runs inside a bubblewrap (bwrap) cage that exposes only the
     chat directory read-write plus read-only system paths (/usr, /bin, /lib,
     /etc). The model cannot read $HOME, /mnt, or anything outside the cage.
     On macOS (no bwrap, no mount namespaces) the envelope falls back to the
     system ``sandbox-exec`` with an equivalent-in-spirit Seatbelt profile.
  2. read_file is restricted to ``chat_dir`` — i.e. files the user has
     attached via @-mention (which land under ``chat_dir/uploads/``) plus
     anything the model itself created through write_file/edit_file.
     Reading arbitrary filesystem paths is forbidden so the model can't scan
     ``~/.ssh``, ``/etc``, AppData, or the rest of the host. Explicit
     allowlist prefixes can grant read-only access to shared agent resources
     such as ``~/.agents``.
  3. write_file and edit_file only accept paths inside the chat directory.

The ``unrestricted`` flag in SettingsData disables all three checks — that's
the user-facing escape hatch for power users.
"""

from __future__ import annotations

import ntpath
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
                    f"Sandbox: reading from the agent system folder is blocked ({path}). "
                    "Enable 'Unrestricted mode' in Settings if you really need it."
                )

        for allowed in self.allowed_read_prefixes:
            if _is_under(norm, _normalize(allowed)):
                return None

        if not self.chat_dir:
            return (
                "Sandbox: reading blocked — this chat has no working folder. "
                "Create a new chat or enable 'Unrestricted mode' in Settings."
            )

        # Path-namespace check: a Windows path in WSL mode (or vice versa)
        # never matches chat_dir under _is_under, so we'd land in the
        # generic "outside chat folder" branch — but the user-facing error
        # is nicer if we call out the mismatch directly.
        chat_is_posix = self.chat_dir.startswith("/")
        path_is_posix = path.startswith("/")
        if chat_is_posix != path_is_posix:
            return (
                f"Sandbox: path '{path}' is on a different filesystem — chat folder is "
                f"{self.chat_dir}. Attach the file via the @-menu."
            )

        if not _is_under(norm, _normalize(self.chat_dir)):
            return (
                f"Sandbox: read_file is only allowed inside the chat folder "
                f"({self.chat_dir}). File '{path}' is outside it. "
                "To grant the model access to a file from your disk, attach it "
                "via the @-menu in the chat (it will be placed in uploads/). "
                "Alternatively, enable 'Unrestricted mode' in Settings."
            )
        return None

    # ── writes ────────────────────────────────────────────────────────

    def check_write(self, path: str) -> str | None:
        """Return an error message if writing to *path* is forbidden, else None."""
        if self.unrestricted:
            return None
        if not self.chat_dir:
            return (
                "Sandbox: no chat working folder (chat_dir_slug is missing). "
                "Create a new chat or enable 'Unrestricted mode'."
            )
        # Path must be absolute in the matching namespace: WSL ("/…") for the
        # bash shell, Windows drive letter for PowerShell. Anything else is
        # rejected outright.
        if self.shell == "powershell":
            if not (len(path) >= 3 and path[1] == ":" and path[2] in ("\\", "/")):
                return (
                    f"Sandbox: writes are only allowed inside the chat folder ({self.chat_dir}). "
                    f"Path '{path}' is not a Windows absolute path."
                )
        else:
            if not path.startswith("/"):
                return (
                    f"Sandbox: writes are only allowed inside the chat folder ({self.chat_dir}). "
                    f"Path '{path}' is not a WSL absolute path."
                )
        if not _is_under(_normalize(path), _normalize(self.chat_dir)):
            return (
                f"Sandbox: writes are only allowed inside {self.chat_dir}; path '{path}' "
                "is outside. Enable 'Unrestricted mode' for arbitrary writes."
            )
        return None

    # ── bash wrap ─────────────────────────────────────────────────────

    def wrap_bash(self, inner_cmd: str) -> str:
        """Return *inner_cmd* wrapped in a bwrap call (Linux/WSL) or a
        sandbox-exec cage (macOS), or the cmd unchanged when unrestricted.

        The wrapper picks the cage at runtime — ``command -v bwrap`` first,
        then ``/usr/bin/sandbox-exec`` — and falls back to a loud error so the
        model doesn't silently break out. Keeping the detection in the shell
        (not in Python) keeps this module platform-free.
        """
        if self.unrestricted:
            # No cage and no path checks — but keep the per-chat dev environment
            # so base functionality isn't lost: create + cd into the chat folder,
            # point HOME at it (pip --user / npm / caches stay per-chat, matching
            # restricted mode), and lead PATH with {chat_dir}/.venv/bin so a venv
            # the model created is active without re-activation. PATH is extended,
            # not replaced — unrestricted users expect host tools to stay reachable.
            if self.chat_dir:
                cwd_q = shlex.quote(self.chat_dir)
                venv_q = shlex.quote(f"{self.chat_dir}/.venv/bin")
                return (
                    f"mkdir -p {cwd_q} && cd {cwd_q} && "
                    f'export HOME={cwd_q} && export PATH={venv_q}:"$PATH" && {inner_cmd}'
                )
            return inner_cmd

        if not self.chat_dir:
            # Restricted but no chat anchor — refuse instead of running uncaged.
            return (
                "echo '[sandbox] no chat working directory; cannot run bash in "
                "restricted mode. Create a chat or toggle Unrestricted mode.' >&2; "
                "exit 126"
            )

        chat_q = shlex.quote(self.chat_dir)
        # Expose the read-allowlist (skill/agent resource dirs) into the cage
        # read-only. read_file already lets the model open these paths; without
        # mounting them here, `cd <skill_dir> && python scripts/x.py` would fail
        # because bwrap only binds chat_dir. We mount only the WSL/posix-form
        # entries (the cage runs inside WSL); the Windows-form duplicates are
        # skipped. --ro-bind-try tolerates a missing path. Scripts read their
        # own assets here and write outputs to cwd (= chat_dir).
        ro_skill_binds: list[str] = []
        for prefix in self.allowed_read_prefixes:
            if prefix.startswith("/") and not _is_under(
                _normalize(self.chat_dir), _normalize(prefix)
            ):
                ro_skill_binds += ["--ro-bind-try", prefix, prefix]
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
            *ro_skill_binds,
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
            # Inner interpreter matches the chosen shell: zsh when the user
            # explicitly picked it, otherwise bash. The binary lives under the
            # ro-bound /usr|/bin mounts, so it's reachable inside the cage.
            "zsh" if self.shell == "zsh" else "bash", "-c", inner_cmd,
        ]
        bwrap_str = " ".join(shlex.quote(a) for a in bwrap_args)

        # macOS twin of the cage: /usr/bin/sandbox-exec (Seatbelt). Deprecated
        # but shipped on every macOS and still driven via `-p` profiles by
        # Apple's own tooling (and Bazel/Nix). No mount namespaces there, so
        # parity is approximate:
        #   - writes: denied everywhere except chat_dir (+ tmp dirs, tty/null
        #     devices) — the same containment bwrap gets from binding only
        #     chat_dir read-write;
        #   - reads: the real $HOME is denied wholesale (protects ~/.ssh,
        #     keychains — matching bwrap's unmounted home), with chat_dir and
        #     the skill allowlist re-allowed on top;
        #   - env: `/usr/bin/env -i` replays --clearenv + --setenv, so API
        #     keys living in the backend process never reach the model's shell;
        #   - no PID/IPC namespaces, and /tmp is shared rather than a private
        #     tmpfs — accepted best-effort deviations.
        mac_shell = "/bin/zsh" if self.shell == "zsh" else "/bin/bash"
        mac_path_entries = [
            f"{self.chat_dir}/.venv/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        sbx_args = [
            "/usr/bin/env", "-i",
            f"HOME={self.chat_dir}",
            f"USER={self.user_name or 'user'}",
            f"LOGNAME={self.user_name or 'user'}",
            f"SHELL={mac_shell}",
            "TERM=xterm-256color",
            "LANG=C.UTF-8",
            "LC_ALL=C.UTF-8",
            "TMPDIR=/tmp",
            "PATH=" + ":".join(mac_path_entries),
            "/usr/bin/sandbox-exec",
            "-p", _sandbox_exec_profile(self.chat_dir, self.allowed_read_prefixes),
            mac_shell, "-c", inner_cmd,
        ]
        sbx_str = " ".join(shlex.quote(a) for a in sbx_args)

        # If neither cage exists, fall through to a friendly error rather
        # than silently dropping the cage — print the install hint and exit 127.
        fallback = (
            "echo '[sandbox] no supported sandbox found. "
            "Linux: install bubblewrap (Debian/Ubuntu: sudo apt install -y bubblewrap; "
            "Arch: sudo pacman -S bubblewrap; Fedora: sudo dnf install bubblewrap). "
            "Or toggle Unrestricted mode in Settings.' >&2; exit 127"
        )
        return (
            f"mkdir -p {chat_q}; "
            f"if command -v bwrap >/dev/null 2>&1; then {bwrap_str}; "
            f"elif [ -x /usr/bin/sandbox-exec ]; then cd {chat_q} && {sbx_str}; "
            f"else {fallback}; fi"
        )

    # ── powershell wrap ───────────────────────────────────────────────

    def wrap_powershell(self, inner_cmd: str) -> str:
        """Return *inner_cmd* prefixed with a chat-dir Set-Location.

        PowerShell on Windows has no bwrap equivalent, so the restricted mode
        is "soft": we only ensure the cwd is the chat folder. The model can
        still resolve absolute Windows paths, but the file-write tools refuse
        anything outside chat_dir, so writes stay contained. The user is told
        in Settings that PowerShell mode disables the kernel-level cage.
        """
        # Force UTF-8 on the captured streams. Windows PowerShell 5.1 emits
        # redirected output in the console's OEM codepage (e.g. cp866 on a
        # Russian Windows), which bash_tool._format_result then mis-decodes as
        # UTF-8 — Cyrillic file names turn into `������`. Setting the console
        # encodings to UTF-8 at the top of every command makes the bytes match
        # what we decode. Applied unconditionally (even with no chat_dir) so
        # listings are always readable.
        enc_prefix = (
            "$OutputEncoding = "
            "[Console]::OutputEncoding = [Console]::InputEncoding = "
            "[System.Text.Encoding]::UTF8; "
        )
        if not self.chat_dir:
            return enc_prefix + inner_cmd
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
        return enc_prefix + prefix + inner_cmd


# ── helpers ───────────────────────────────────────────────────────────


def _sbpl_quote(path: str) -> str:
    """Quote a path for embedding in an SBPL (Seatbelt profile) string literal."""
    return '"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _sandbox_exec_profile(chat_dir: str, allowed_read_prefixes: tuple[str, ...]) -> str:
    """SBPL profile for the macOS sandbox-exec cage — wrap_bash's bwrap twin.

    In SBPL the *last* matching rule wins, so the shape is: allow everything,
    deny all writes, re-allow chat_dir + tmp + tty devices, deny reading the
    real home (derived from the app's own ``<home>/AgentChat/chats/<slug>``
    layout — the only layout api/chats.py ever creates), then re-allow
    chat_dir and the skill allowlist back inside it. ``/private/...`` twins
    cover macOS's ``/tmp`` → ``/private/tmp`` symlinks, which Seatbelt matches
    post-resolution; ``/private/var/folders`` is where per-user TMPDIRs live.
    """
    q = _sbpl_quote
    write_allows = [
        f"(subpath {q(chat_dir)})",
        '(subpath "/private/tmp")',
        '(subpath "/private/var/tmp")',
        '(subpath "/private/var/folders")',
        '(subpath "/tmp")',
        '(literal "/dev/null")',
        '(literal "/dev/stdout")',
        '(literal "/dev/stderr")',
        '(literal "/dev/tty")',
        '(literal "/dev/dtracehelper")',
        '(regex #"^/dev/ttys[0-9]+$")',
    ]
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        "(allow file-write* " + " ".join(write_allows) + ")",
    ]
    home = chat_dir.split("/AgentChat/chats/", 1)[0] if "/AgentChat/chats/" in chat_dir else ""
    if home and home != "/":
        read_allows = [f"(subpath {q(chat_dir)})"]
        for prefix in allowed_read_prefixes:
            if prefix.startswith("/"):
                read_allows.append(f"(subpath {q(prefix)})")
        lines.append(f"(deny file-read* (subpath {q(home)}))")
        lines.append("(allow file-read* " + " ".join(read_allows) + ")")
    return " ".join(lines)


def _normalize(path: str) -> str:
    """Normalize a path for prefix comparison.

    Critically, this collapses ``..`` and ``.`` segments LEXICALLY so that
    paths like ``/home/x/chat/uploads/../../etc/passwd`` resolve to
    ``/etc/passwd`` before the chat_dir prefix check runs. Without this,
    the sandbox is bypassable via a literal-prefix-but-traversed path.

    Posix-style paths use ``posixpath.normpath``; Windows-style paths use
    ``ntpath.normpath`` and are then lowercased (Windows is case-insensitive).
    The namespace is chosen by the path's own shape, never by the host OS —
    ``os.path`` is ``posixpath`` on Linux, which leaves a Windows path's ``..``
    segments and backslashes untouched and would silently turn the traversal
    guard above into a no-op. The two namespaces never overlap, so this is
    enough to block lookups in both at once.
    """
    if not path:
        return ""
    if path.startswith("/"):
        return posixpath.normpath(path)
    return ntpath.normpath(path).lower()


def _is_under(child: str, parent: str) -> bool:
    """True iff *child* is *parent* or a descendant of it."""
    if not parent:
        return False
    if child == parent:
        return True
    # Separator follows the parent's namespace, not the host's: os.sep is "/"
    # on Linux, which never matches a "\"-joined Windows child.
    sep = "/" if parent.startswith("/") else "\\"
    if not parent.endswith(sep):
        parent_with_sep = parent + sep
    else:
        parent_with_sep = parent
    return child.startswith(parent_with_sep)
