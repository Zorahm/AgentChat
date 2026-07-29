from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ToolCallSpec(BaseModel):
    """A single tool invocation replayed from a prior assistant turn."""

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ChatMessage(BaseModel):
    role: str
    content: str
    tool_calls: list[ToolCallSpec] | None = Field(
        default=None,
        description="On an assistant message: tool calls made during that turn, "
        "replayed so the model remembers what it did.",
    )
    tool_call_id: str | None = Field(
        default=None,
        description="On a 'tool' message: the id of the assistant tool call this "
        "result answers.",
    )


class AttachmentInfo(BaseModel):
    name: str
    path: str | None = None
    size: int
    mime_type: str
    content: str | None = None
    data_url: str | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str | None = Field(default=None, description="Override the configured model")
    attachments: list[AttachmentInfo] | None = None
    chat_dir_slug: str | None = Field(
        default=None,
        description="Per-chat working directory slug (chat-{id}-{ts}). bash_tool cwd's into ~/AgentChat/chats/{slug}/.",
    )
    chat_id: str | None = Field(
        default=None,
        description="Chat ID for backend persistence after stream completes.",
    )
    project_id: str | None = Field(
        default=None,
        description="Project this chat belongs to. The project's prompt + extracted "
        "file text is injected into the system prompt for this turn.",
    )
    agent_id: str | None = Field(
        default=None,
        description="Agent profile attached to this chat. Falls back to the default "
        "agent when None or unknown. A non-empty agent system_prompt REPLACES the "
        "built-in dynamic system prompt entirely for this turn.",
    )
    mcp_enabled_servers: list[str] | None = Field(
        default=None,
        description="IDs of MCP servers to wire in for this turn. Unknown / disabled IDs are skipped silently.",
    )
    thinking_enabled: bool | None = Field(
        default=None,
        description="User-level thinking preference. When False, thinking is always disabled. "
        "When True, thinking is enabled only if the model supports it. "
        "When None, falls back to model config.",
    )
    web_search_enabled: bool | None = Field(
        default=None,
        description="Per-chat web search toggle (the globe button). When falsy, no "
        "web search tools are wired for the turn.",
    )
    web_search_mode: str | None = Field(
        default=None,
        description="Requested web search mode: auto|native|litellm|searxng. "
        "Falls back to the configured default when None.",
    )
    research_enabled: bool | None = Field(
        default=None,
        description="Per-chat research toggle. When truthy, the `research` tool "
        "(deep multi-step web research → report.md) is wired for the turn. Falls "
        "back to the persisted sticky default when None.",
    )
    effort: str | None = Field(
        default=None,
        description="Reasoning effort level (low/medium/high/max/xhigh). "
        "Only applies to models that support effort levels.",
    )
