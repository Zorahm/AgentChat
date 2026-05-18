"""API request / response models — Phase 3."""

from __future__ import annotations

from pydantic import BaseModel, Field


# ── Chat ──────────────────────────────────────────────────────────────


class ChatMessage(BaseModel):
    """A single message in the conversation history."""

    role: str  # "user" | "assistant"
    content: str


class AttachmentInfo(BaseModel):
    """Metadata + extracted content for an attached file."""

    name: str
    path: str | None = None
    size: int
    mime_type: str
    content: str | None = None
    data_url: str | None = None


class ChatRequest(BaseModel):
    """Incoming chat request. Client sends the full conversation history."""

    messages: list[ChatMessage]
    model: str | None = Field(default=None, description="Override the configured model")
    attachments: list[AttachmentInfo] | None = None


# ── Skills ────────────────────────────────────────────────────────────


class SkillInfo(BaseModel):
    """Public info about an installed skill."""

    name: str
    description: str = ""
    version: str = ""
    author: str = ""


class InstallRequest(BaseModel):
    """Request to install a skill by registry name."""

    source: str = Field(description="Skill name in the registry (e.g. 'docx')")


class SkillContent(BaseModel):
    """SKILL.md content response."""

    name: str
    content: str


# ── Settings ──────────────────────────────────────────────────────────


class ModelConfig(BaseModel):
    """A single model entry with optional thinking flag."""

    id: str  # "openai/gpt-4o"
    name: str | None = None  # display name, defaults to id
    thinking: bool | None = None  # None = provider default, True = enabled, False = disabled


class ProviderConfig(BaseModel):
    """Per-provider configuration."""

    id: str
    name: str
    api_key: str | None = None
    api_base: str | None = None
    enabled: bool = True
    api_key_set: bool = False
    custom: bool = False  # user-added provider (OpenAI-compatible); deletable


class ProviderCreate(BaseModel):
    """Payload for creating a custom OpenAI-compatible provider."""

    id: str = Field(min_length=1, pattern=r"^[a-z0-9_\-]+$")
    name: str = Field(min_length=1)
    api_base: str = Field(min_length=1)
    api_key: str | None = None


class SettingsData(BaseModel):
    """Current application settings."""

    providers: list[ProviderConfig] = Field(default_factory=list)
    models: list[ModelConfig] = Field(default_factory=list)
    default_model: str = "openai/gpt-4o"
    temperature: float = 0.7
    max_iterations: int = 10
    user_name: str = ""
    theme: str = "system"


class SettingsUpdate(BaseModel):
    """Partial global settings update."""

    default_model: str | None = None
    temperature: float | None = None
    max_iterations: int | None = None
    user_name: str | None = None
    theme: str | None = None


class ProviderUpdate(BaseModel):
    """Partial update for a single provider."""

    api_key: str | None = None
    api_base: str | None = None
    enabled: bool | None = None


# ── Common ────────────────────────────────────────────────────────────


class ErrorResponse(BaseModel):
    """Standard error payload."""

    detail: str
