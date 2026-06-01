"""Tests for cross-turn history reconstruction (build_agent_messages).

Regression guard: prior turns must replay their tool calls + results, not just
the assistant's closing text. Otherwise every fact the model learned via a tool
is dropped between turns and it re-does the work ("forgets" mid-chat).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from api.chat import build_agent_messages
from api.schemas.chat import ChatMessage, ToolCallSpec


def test_plain_turns_pass_through() -> None:
    history = [
        ChatMessage(role="user", content="hi"),
        ChatMessage(role="assistant", content="hello"),
    ]
    assert build_agent_messages(history) == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]


def test_assistant_tool_calls_are_replayed() -> None:
    history = [
        ChatMessage(role="user", content="read the pdf"),
        ChatMessage(
            role="assistant",
            content="Extracting…",
            tool_calls=[
                ToolCallSpec(id="call_1", name="bash_tool", arguments={"command": "pdftotext x.pdf -"}),
            ],
        ),
        ChatMessage(role="tool", content="Question 1...\nQuestion 45...", tool_call_id="call_1"),
        ChatMessage(role="assistant", content="Got all 45 questions."),
    ]

    out = build_agent_messages(history)

    assistant = out[1]
    assert assistant["role"] == "assistant"
    assert assistant["content"] == "Extracting…"
    assert assistant["tool_calls"][0]["id"] == "call_1"
    assert assistant["tool_calls"][0]["type"] == "function"
    assert assistant["tool_calls"][0]["function"]["name"] == "bash_tool"
    # arguments must be a JSON string for the OpenAI/LiteLLM contract
    assert json.loads(assistant["tool_calls"][0]["function"]["arguments"]) == {
        "command": "pdftotext x.pdf -"
    }

    tool_msg = out[2]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "call_1"
    assert "Question 45" in tool_msg["content"]


def test_tool_message_without_id_gets_empty_string() -> None:
    out = build_agent_messages([ChatMessage(role="tool", content="x")])
    assert out == [{"role": "tool", "tool_call_id": "", "content": "x"}]
