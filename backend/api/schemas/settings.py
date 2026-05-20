from __future__ import annotations

from pydantic import BaseModel, Field


class ModelConfig(BaseModel):
    id: str
    name: str | None = None
    thinking: bool | None = None


class ProviderConfig(BaseModel):
    id: str
    name: str
    api_key: str | None = None
    api_base: str | None = None
    enabled: bool = True
    api_key_set: bool = False
    custom: bool = False


class ProviderCreate(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9_\-]+$")
    name: str = Field(min_length=1)
    api_base: str = Field(min_length=1)
    api_key: str | None = None


class SettingsData(BaseModel):
    providers: list[ProviderConfig] = Field(default_factory=list)
    models: list[ModelConfig] = Field(default_factory=list)
    default_model: str = "openai/gpt-4o"
    temperature: float = 0.7
    max_iterations: int = 10
    user_name: str = ""
    theme: str = "system"
    onboarding_completed: bool = False
    unrestricted_mode: bool = False
    # "auto" — use WSL if available, fall back to PowerShell on Windows.
    # "wsl" — force WSL (errors if missing). "powershell" — force PowerShell.
    shell_preference: str = "auto"


class SettingsUpdate(BaseModel):
    default_model: str | None = None
    temperature: float | None = None
    max_iterations: int | None = None
    user_name: str | None = None
    theme: str | None = None
    onboarding_completed: bool | None = None
    unrestricted_mode: bool | None = None
    shell_preference: str | None = None


class ProviderUpdate(BaseModel):
    api_key: str | None = None
    api_base: str | None = None
    enabled: bool | None = None
