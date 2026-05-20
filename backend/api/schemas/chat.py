from __future__ import annotations

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str
    content: str


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
