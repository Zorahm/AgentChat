"""Tests for sandbox read allowlists."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy


def test_allowed_agents_dir_can_be_read_outside_chat_dir() -> None:
    policy = SandboxPolicy(
        chat_dir="C:\\Users\\ZorahM\\AgentChat\\chats\\chat-abcd-20260523-1200",
        allowed_read_prefixes=("C:\\Users\\ZorahM\\.agents",),
    )

    denied = policy.check_read("C:\\Users\\ZorahM\\.agents\\skills\\demo\\SKILL.md")

    assert denied is None


def test_blocked_prefix_wins_over_allowed_prefix() -> None:
    policy = SandboxPolicy(
        chat_dir="C:\\Users\\ZorahM\\AgentChat\\chats\\chat-abcd-20260523-1200",
        blocked_read_prefixes=("C:\\Users\\ZorahM\\.agents\\private",),
        allowed_read_prefixes=("C:\\Users\\ZorahM\\.agents",),
    )

    denied = policy.check_read("C:\\Users\\ZorahM\\.agents\\private\\settings.json")

    assert denied is not None
