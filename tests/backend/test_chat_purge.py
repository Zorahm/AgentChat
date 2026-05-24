"""Tests for chat working directory purge commands."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.chats import _build_purge_chat_dir_command


def test_purge_command_targets_expected_wsl_user_home() -> None:
    cmd = _build_purge_chat_dir_command(
        "chat-iyuu-20260523-1144",
        expected_home="/home/zorahm",
    )

    # Literal-path branch for the Python-resolved home.
    assert "rm -rf -- /home/zorahm/AgentChat/chats/chat-iyuu-20260523-1144" in cmd
    # $HOME-based branch with case guard — no in-script variable assignments
    # (those silently fail on some Windows+WSL+`bash -lc` argv combinations).
    assert 'case "$HOME/AgentChat/chats/chat-iyuu-20260523-1144" in' in cmd
    assert "/home/*/AgentChat/chats/chat-iyuu-20260523-1144)" in cmd
    assert 'rm -rf -- "$HOME/AgentChat/chats/chat-iyuu-20260523-1144"' in cmd
    # No legacy local-variable forms.
    assert "slug=" not in cmd
    assert "target=" not in cmd
    assert "for base in" not in cmd


def test_purge_command_skips_non_home_expected_path() -> None:
    cmd = _build_purge_chat_dir_command(
        "chat-iyuu-20260523-1144",
        expected_home="/etc",
    )
    # Untrusted expected_home is dropped; only the $HOME-guarded branch survives.
    assert "/etc/" not in cmd
    assert 'case "$HOME/AgentChat/chats/chat-iyuu-20260523-1144" in' in cmd


def test_purge_command_rejects_unsafe_slug() -> None:
    assert _build_purge_chat_dir_command("../chat-iyuu", expected_home="/home/zorahm") == ""
    assert _build_purge_chat_dir_command("", expected_home="/home/zorahm") == ""
    assert _build_purge_chat_dir_command("chat-x;rm -rf /", expected_home="/home/zorahm") == ""
