"""Tests for sandbox read allowlists.

Both path namespaces run on every host. SandboxPolicy picks its rules from the
path's own shape (drive letter vs leading ``/``), never from the OS the tests
happen to run on, so the Windows cases must hold on Linux too — and vice versa.
Paths here are synthetic strings, never touched on disk, which is what lets a
single host cover both.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.sandbox import SandboxPolicy


@dataclass(frozen=True)
class _Paths:
    """One set of fixture paths, all in a single filesystem namespace."""

    chat_dir: str
    agents_dir: str
    skill_file: str  # inside agents_dir, outside chat_dir
    private_dir: str  # inside agents_dir
    private_file: str  # inside private_dir
    inside_via_traversal: str  # leaves a subfolder and comes back into chat_dir
    escape_via_traversal: str  # climbs out of chat_dir entirely


WINDOWS = _Paths(
    chat_dir="C:\\Users\\ZorahM\\AgentChat\\chats\\chat-abcd-20260523-1200",
    agents_dir="C:\\Users\\ZorahM\\.agents",
    skill_file="C:\\Users\\ZorahM\\.agents\\skills\\demo\\SKILL.md",
    private_dir="C:\\Users\\ZorahM\\.agents\\private",
    private_file="C:\\Users\\ZorahM\\.agents\\private\\settings.json",
    inside_via_traversal=(
        "C:\\Users\\ZorahM\\AgentChat\\chats\\chat-abcd-20260523-1200\\uploads\\..\\notes.txt"
    ),
    escape_via_traversal=(
        "C:\\Users\\ZorahM\\AgentChat\\chats\\chat-abcd-20260523-1200"
        "\\uploads\\..\\..\\..\\..\\.ssh\\id_rsa"
    ),
)

POSIX = _Paths(
    chat_dir="/home/zorahm/AgentChat/chats/chat-abcd-20260523-1200",
    agents_dir="/home/zorahm/.agents",
    skill_file="/home/zorahm/.agents/skills/demo/SKILL.md",
    private_dir="/home/zorahm/.agents/private",
    private_file="/home/zorahm/.agents/private/settings.json",
    inside_via_traversal=(
        "/home/zorahm/AgentChat/chats/chat-abcd-20260523-1200/uploads/../notes.txt"
    ),
    escape_via_traversal=(
        "/home/zorahm/AgentChat/chats/chat-abcd-20260523-1200/uploads/../../../../.ssh/id_rsa"
    ),
)

both_namespaces = pytest.mark.parametrize("paths", [WINDOWS, POSIX], ids=["windows", "posix"])


@both_namespaces
def test_allowed_agents_dir_can_be_read_outside_chat_dir(paths: _Paths) -> None:
    policy = SandboxPolicy(
        chat_dir=paths.chat_dir,
        allowed_read_prefixes=(paths.agents_dir,),
    )

    denied = policy.check_read(paths.skill_file)

    assert denied is None


@both_namespaces
def test_blocked_prefix_wins_over_allowed_prefix(paths: _Paths) -> None:
    policy = SandboxPolicy(
        chat_dir=paths.chat_dir,
        blocked_read_prefixes=(paths.private_dir,),
        allowed_read_prefixes=(paths.agents_dir,),
    )

    # The blocked subtree loses the grant its parent allowlist entry gave it …
    assert policy.check_read(paths.private_file) is not None
    # … while the rest of that allowed tree stays readable. Without this second
    # assertion the first would also pass under a policy that denies everything.
    assert policy.check_read(paths.skill_file) is None


@both_namespaces
def test_traversal_out_of_chat_dir_is_blocked(paths: _Paths) -> None:
    policy = SandboxPolicy(chat_dir=paths.chat_dir)

    assert policy.check_read(paths.escape_via_traversal) is not None


@both_namespaces
def test_traversal_back_inside_chat_dir_is_allowed(paths: _Paths) -> None:
    """``..`` is collapsed lexically before the prefix check runs.

    The counterpart to the escape test above: a policy that merely compared
    literal prefixes would block the escape too, so this is what proves the
    escape is caught by the collapse rather than by a string mismatch.
    """
    policy = SandboxPolicy(chat_dir=paths.chat_dir)

    assert policy.check_read(paths.inside_via_traversal) is None


def test_wrap_powershell_forces_utf8_output() -> None:
    """Cyrillic file names came back as mojibake because Windows PowerShell
    emits redirected output in the OEM codepage, not UTF-8. Every wrapped
    command must set the console encodings to UTF-8 first."""
    policy = SandboxPolicy(
        chat_dir="C:\\Users\\ZorahM\\AgentChat\\chats\\chat-abcd",
        shell="powershell",
    )

    wrapped = policy.wrap_powershell("Get-ChildItem")

    assert "[System.Text.Encoding]::UTF8" in wrapped
    assert wrapped.index("OutputEncoding") < wrapped.index("Get-ChildItem")


def test_wrap_powershell_forces_utf8_even_without_chat_dir() -> None:
    policy = SandboxPolicy(shell="powershell")

    wrapped = policy.wrap_powershell("Get-ChildItem")

    assert "[System.Text.Encoding]::UTF8" in wrapped
