"""Shell-dialect prompt fragments: environment block, bash_tool notes, WSL tips.

The chat working folder lives on whichever filesystem the active shell targets,
so the identity block and the ``bash_tool`` guidance both vary by dialect
(``wsl`` / ``powershell`` / ``posix`` / ``zsh``). An unknown value falls back to
``wsl`` (the historical default) with a warning rather than crashing.
"""

from __future__ import annotations

import logging

from paths import USER_HOME, WSL_USER_HOME

logger = logging.getLogger(__name__)

KNOWN_SHELLS = ("wsl", "powershell", "posix", "zsh")


def normalize_shell(shell: str) -> str:
    """Return a supported shell id, falling back to ``wsl`` with a warning."""
    if shell in KNOWN_SHELLS:
        return shell
    logger.warning("unknown shell %r — falling back to 'wsl'", shell)
    return "wsl"


def shell_block(shell: str) -> str:
    """The ``Home:``/``Shell:`` identity lines for the active dialect."""
    shell = normalize_shell(shell)
    if shell == "powershell":
        return (
            f"Home (Windows): {USER_HOME}\n"
            f"Shell: Windows PowerShell — WSL is not available on this machine."
        )
    if shell == "posix":
        return (
            f"Home: {USER_HOME}\n"
            f"Shell: bash (native Linux/macOS). Note: bash_tool itself always runs commands "
            "through bash regardless of host OS, but on macOS the user's own interactive "
            "terminal defaults to zsh, not bash — if you write a script with a shebang, tell "
            "the user to run something themselves, or generate config for their shell (.bashrc "
            "vs .zshrc), don't assume bash. zsh differs from bash in real ways: arrays are "
            "1-indexed, unquoted variables don't word-split by default, `[[ ]]`/globbing mostly "
            "match but bash-isms like `${var,,}` or associative-array syntax may not."
        )
    if shell == "zsh":
        return f"Home: {USER_HOME}\nShell: zsh (native macOS/Linux)."
    return (
        f"Home (WSL): {WSL_USER_HOME}\n"
        f"Home (Windows): {USER_HOME}\n"
        f"Shell: bash inside WSL."
    )


def bash_desc(shell: str) -> str:
    """The ``bash_tool`` bullet: working-directory contract + dialect notes."""
    shell = normalize_shell(shell)
    if shell == "powershell":
        return (
            "- bash_tool — execute a Windows PowerShell command. The working directory is the "
            f"current chat's folder under {USER_HOME}\\AgentChat\\chats\\chat-<id>-<timestamp>\\. "
            "Every command already starts in this folder — do NOT `Set-Location` into it first, "
            "just run the command directly. Each call is a fresh shell that starts here, so a "
            "`Set-Location` elsewhere does not carry over to the next call; only change directory "
            "when a single command genuinely needs to work somewhere else. "
            "Use PowerShell syntax: `$env:VAR`, `Get-ChildItem`, `Set-Location`, backtick for line "
            "continuation. `&&` is NOT available — chain with `;` or `if ($?) { ... }`."
        )
    if shell == "posix":
        return (
            "- bash_tool — execute bash commands on the local machine. $USER and $HOME are set. "
            "Working directory is the current chat's folder under "
            "~/AgentChat/chats/chat-<id>-<timestamp>/ — files you create with relative paths land "
            "there. Every command already starts in this folder — do NOT `cd` into it first, just "
            "run the command directly. Each call is a fresh shell that starts here, so a `cd` "
            "elsewhere does not carry over to the next call; only `cd` when a single command "
            "genuinely needs to work somewhere else. "
            "Use absolute paths only when you explicitly need to write somewhere else."
        )
    if shell == "zsh":
        return (
            "- bash_tool — execute zsh commands on the local machine. $USER and $HOME are set. "
            "Working directory is the current chat's folder under "
            "~/AgentChat/chats/chat-<id>-<timestamp>/ — files you create with relative paths land "
            "there. Every command already starts in this folder — do NOT `cd` into it first, just "
            "run the command directly. Each call is a fresh shell that starts here, so a `cd` "
            "elsewhere does not carry over to the next call; only `cd` when a single command "
            "genuinely needs to work somewhere else. "
            "Use absolute paths only when you explicitly need to write somewhere else. "
            "This is zsh, NOT bash — do not assume bash-only syntax. Key differences: arrays are "
            "1-indexed (not 0); unquoted variable expansion does not word-split by default (use "
            "`${=var}` or set `SH_WORD_SPLIT` if you need bash-style splitting); glob qualifiers "
            "(`*(.)`, `*(/)`) replace a lot of `find` one-liners; `[[ ]]` conditionals match bash; "
            "bash-only builtins/syntax have zsh equivalents — `${var,,}`/`${var^^}` → "
            "`${(L)var}`/`${(U)var}`, `declare -A` → `typeset -A`, `mapfile`/`readarray` → "
            "`read -A` or a `while read` loop. Prefer POSIX-compatible syntax when it works in "
            "both, to keep scripts portable."
        )
    return (
        "- bash_tool — execute bash commands inside WSL. $USER and $HOME are set. Working "
        "directory is the current chat's folder under ~/AgentChat/chats/chat-<id>-<timestamp>/ "
        "— files you create with relative paths land there. Every command already starts in "
        "this folder — do NOT `cd` into it first, just run the command directly. Each call is "
        "a fresh shell that starts here, so a `cd` elsewhere does not carry over to the next "
        "call; only `cd` when a single command genuinely needs to work somewhere else. "
        "Use absolute paths only when you explicitly need to write somewhere else."
    )


def wsl_notes(shell: str) -> str:
    """WSL-only pandoc/DNS tips — empty for every other dialect."""
    if normalize_shell(shell) != "wsl":
        return ""
    return (
        "Pandoc and the extractors above are preinstalled in WSL. If a command says "
        '"command not found", install it once with `apt-get install -y '
        "--no-install-recommends <pkg>` before retrying.\n\nIf `apt-get`, `pip`, or `npm` "
        'fail with hostname errors ("Could not resolve host", "Temporary failure in name '
        'resolution"), WSL DNS is broken. Do NOT patch /etc/resolv.conf yourself — it is '
        "bind-mounted and your edits revert on next launch. Tell the user: \"WSL DNS is "
        "broken. Open Settings → Shell (or the Onboarding wizard) and click the Fix DNS "
        'button." Then wait for them to fix it before continuing.'
    )
