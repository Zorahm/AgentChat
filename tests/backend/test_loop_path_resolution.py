"""Tests for AgentLoop._absolutize_tool_paths — the artifact-panel desync fix.

Models pass file paths relative to the chat folder; the artifact panel and the
/files endpoints need absolute paths or preview/download fail on a file that
exists. The loop resolves them before emitting/persisting the tool input.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from agent.loop import AgentLoop
from agent.sandbox import SandboxPolicy


def _loop(policy: SandboxPolicy) -> AgentLoop:
    # Bypass __init__ (needs config/tools/llm) — the method only uses _policy.
    loop = AgentLoop.__new__(AgentLoop)
    loop._policy = policy
    return loop


class TestAbsolutizeToolPaths:
    def test_present_files_relative_to_absolute_wsl(self) -> None:
        loop = _loop(SandboxPolicy(chat_dir="/home/u/AgentChat/chats/c1", shell="wsl"))
        out = loop._absolutize_tool_paths("present_files", {"paths": ["report.docx", "sub/x.pdf"]})
        assert out["paths"] == [
            "/home/u/AgentChat/chats/c1/report.docx",
            "/home/u/AgentChat/chats/c1/sub/x.pdf",
        ]

    def test_present_files_absolute_unchanged(self) -> None:
        loop = _loop(SandboxPolicy(chat_dir="/home/u/AgentChat/chats/c1", shell="wsl"))
        out = loop._absolutize_tool_paths("present_files", {"paths": ["/tmp/already.pdf"]})
        assert out["paths"] == ["/tmp/already.pdf"]

    def test_present_files_bare_string_path(self) -> None:
        loop = _loop(SandboxPolicy(chat_dir="/home/u/c1", shell="wsl"))
        out = loop._absolutize_tool_paths("present_files", {"path": "deck.pptx"})
        assert out["paths"] == ["/home/u/c1/deck.pptx"]
        assert "path" not in out  # normalized to the array form

    def test_write_file_path_resolved(self) -> None:
        loop = _loop(SandboxPolicy(chat_dir="/home/u/c1", shell="wsl"))
        out = loop._absolutize_tool_paths("write_file", {"path": "out.docx", "content": "x"})
        assert out["path"] == "/home/u/c1/out.docx"
        assert out["content"] == "x"

    def test_windows_chat_dir(self) -> None:
        loop = _loop(SandboxPolicy(chat_dir=r"C:\Users\me\chats\c1", shell="powershell"))
        out = loop._absolutize_tool_paths("present_files", {"paths": ["report.xlsx"]})
        assert out["paths"][0].replace("/", "\\") == r"C:\Users\me\chats\c1\report.xlsx"

    def test_non_file_tool_untouched(self) -> None:
        loop = _loop(SandboxPolicy(chat_dir="/home/u/c1", shell="wsl"))
        args = {"command": "ls -la"}
        assert loop._absolutize_tool_paths("bash_tool", args) == args
