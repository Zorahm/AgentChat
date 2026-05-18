"""Agent configuration model."""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentConfig(BaseModel):
    """Configuration for the agent loop — model, limits, prompt."""

    model: str = Field(
        default="gpt-4o",
        description="LiteLLM model identifier (e.g. gpt-4o, claude-3-opus-20240229)",
    )
    max_iterations: int = Field(
        default=10,
        ge=1,
        le=200,
        description="Maximum agent loop iterations before forced stop",
    )
    system_prompt: str = Field(
        default="You are a helpful AI assistant with access to tools. "
        "Use tools when needed to answer accurately.",
        description="System prompt inserted at the start of every conversation",
    )
    api_base: str | None = Field(
        default=None,
        description="Custom API base URL for LiteLLM proxy or compatible provider",
    )
    api_key: str | None = Field(
        default=None,
        description="API key for the model provider",
    )
    temperature: float = Field(
        default=0.7,
        ge=0.0,
        le=2.0,
    )
    extra_body: dict | None = Field(
        default=None,
        description="Extra request body fields passed to LiteLLM (e.g. thinking config).",
    )
