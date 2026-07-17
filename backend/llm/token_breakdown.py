"""Best-effort local estimate of where prompt tokens go.

Purely informational — shown as a per-message tooltip and a dashboard chart so
a short user message that still billed thousands of tokens is explained
(system prompt, skills manifest, project "memory" files, tool schemas, or
prior conversation — not the message itself). The billed total always comes
from the provider's own ``usage.prompt_tokens``; this never overrides it, it
only explains it.

Categories mirror Claude Code's context-window breakdown where AgentChat has
a direct analogue: system prompt, skills manifest ("Skills"), project
instructions + extracted files ("Memory files", AgentChat's CLAUDE.md
equivalent), built-in tool schemas ("System tools"), MCP tool schemas ("MCP
tools"), prior conversation, and the newest message. There's no equivalent of
Claude Code's autocompact buffer / deferred-tool slots — AgentChat resends
the full context every call, it doesn't manage a context budget.
"""

from __future__ import annotations

import json
from typing import Any

import litellm


def _is_mcp_tool(tool_def: dict[str, Any]) -> bool:
    name = (tool_def.get("function") or {}).get("name") or ""
    return str(name).startswith("mcp__")


def estimate_prompt_breakdown(
    model: str,
    system_prompt: str,
    project_context: str,
    skills_manifest: str,
    tools: list[dict[str, Any]] | None,
    history: list[dict[str, Any]],
    new_user_message: bool,
) -> dict[str, int]:
    """``history`` is ``AgentLoop.messages`` (no system message in it). When
    ``new_user_message`` is True, the trailing user message is split out as
    ``message`` instead of folded into ``history`` — that's the case that
    explains "why did my short question cost thousands of tokens".
    """
    try:
        if new_user_message and history and history[-1].get("role") == "user":
            history_msgs, latest_msgs = history[:-1], [history[-1]]
        else:
            history_msgs, latest_msgs = history, []

        builtin_tools = [t for t in (tools or []) if not _is_mcp_tool(t)]
        mcp_tools = [t for t in (tools or []) if _is_mcp_tool(t)]

        def count_text(text: str) -> int:
            return litellm.token_counter(model=model, text=text) if text else 0

        def count_tools(defs: list[dict[str, Any]]) -> int:
            return litellm.token_counter(model=model, text=json.dumps(defs)) if defs else 0

        def count_messages(msgs: list[dict[str, Any]]) -> int:
            return litellm.token_counter(model=model, messages=msgs) if msgs else 0

        return {
            "system": count_text(system_prompt),
            "memory": count_text(project_context),
            "skills": count_text(skills_manifest),
            "tools": count_tools(builtin_tools),
            "mcp_tools": count_tools(mcp_tools),
            "history": count_messages(history_msgs),
            "message": count_messages(latest_msgs),
        }
    except Exception:  # noqa: BLE001 — a missing breakdown beats a broken chat
        return {}
