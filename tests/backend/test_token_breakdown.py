"""Tests for the local prompt-token breakdown estimator."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from llm.token_breakdown import estimate_prompt_breakdown  # noqa: E402


def _tool(name: str) -> dict:
    return {"type": "function", "function": {"name": name, "parameters": {"type": "object"}}}


def test_splits_every_category() -> None:
    history = [
        {"role": "user", "content": "earlier question"},
        {"role": "assistant", "content": "earlier answer"},
        {"role": "user", "content": "Say hi"},
    ]
    tools = [_tool("bash_tool"), _tool("mcp__github__search_issues")]

    result = estimate_prompt_breakdown(
        model="gpt-4o",
        system_prompt="You are a helpful assistant with many rules." * 5,
        project_context="Project instructions and extracted file text." * 3,
        skills_manifest="Available skills: docx, pptx, xlsx.",
        tools=tools,
        history=history,
        new_user_message=True,
    )

    assert result["system"] > 0
    assert result["memory"] > 0
    assert result["skills"] > 0
    assert result["tools"] > 0
    assert result["mcp_tools"] > 0
    assert result["history"] > 0  # the earlier user/assistant pair
    assert result["message"] > 0
    # The short new message should cost far fewer tokens than the system prompt.
    assert result["message"] < result["system"]


def test_empty_optional_components_are_zero() -> None:
    result = estimate_prompt_breakdown(
        model="gpt-4o",
        system_prompt="System prompt",
        project_context="",
        skills_manifest="",
        tools=None,
        history=[{"role": "user", "content": "hi"}],
        new_user_message=True,
    )

    assert result["memory"] == 0
    assert result["skills"] == 0
    assert result["tools"] == 0
    assert result["mcp_tools"] == 0
    assert result["history"] == 0


def test_no_new_message_folds_everything_into_history() -> None:
    history = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": None, "tool_calls": []},
        {"role": "tool", "tool_call_id": "1", "content": "tool result"},
    ]

    result = estimate_prompt_breakdown(
        model="gpt-4o",
        system_prompt="System prompt",
        project_context="",
        skills_manifest="",
        tools=None,
        history=history,
        new_user_message=False,
    )

    assert result["message"] == 0
    assert result["history"] > 0


def test_builtin_and_mcp_tools_counted_separately() -> None:
    result = estimate_prompt_breakdown(
        model="gpt-4o",
        system_prompt="System",
        project_context="",
        skills_manifest="",
        tools=[_tool("bash_tool"), _tool("write_file"), _tool("mcp__slack__send_message")],
        history=[],
        new_user_message=False,
    )

    assert result["tools"] > 0
    assert result["mcp_tools"] > 0
    assert result["tools"] != result["mcp_tools"]


def test_never_raises_on_malformed_input() -> None:
    result = estimate_prompt_breakdown(
        model="unknown-model-xyz",
        system_prompt="x",
        project_context="",
        skills_manifest="",
        tools=[{"weird": "shape"}],
        history=[{"weird": "shape"}],
        new_user_message=True,
    )
    assert isinstance(result, dict)
