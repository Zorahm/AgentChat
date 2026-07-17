from __future__ import annotations

from pydantic import BaseModel, Field

from mcp_integration.config import MCPServerConfig


class ModelConfig(BaseModel):
    id: str
    name: str | None = None
    thinking: bool | None = None
    thinking_types: list[str] | None = None
    effort_levels: list[str] | None = None
    # Native web-search capability, when the provider's models API reports it.
    web_search: bool | None = None


class ProviderConfig(BaseModel):
    id: str
    name: str
    api_key: str | None = None
    api_base: str | None = None
    enabled: bool = True
    api_key_set: bool = False
    custom: bool = False
    extra_headers: dict[str, str] | None = None


class ProviderCreate(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9_\-]+$")
    name: str = Field(min_length=1)
    api_base: str = Field(min_length=1)
    api_key: str | None = None
    extra_headers: dict[str, str] | None = None


class SettingsData(BaseModel):
    providers: list[ProviderConfig] = Field(default_factory=list)
    models: list[ModelConfig] = Field(default_factory=list)
    default_model: str = "openai/gpt-4o"
    temperature: float = 0.7
    max_iterations: int = 50
    user_name: str = ""
    theme: str = "system"
    # Play a chime when a model reply or an install finishes (only while the
    # window is unfocused/hidden). Opt-in — off by default.
    notify_sound: bool = False
    # Optional custom notification sound, stored as a data URL
    # (e.g. "data:audio/mpeg;base64,..."). None → use the built-in synth chime.
    notify_sound_data: str | None = None
    # Display name of the chosen sound file (UI only; helps the user see what's set).
    notify_sound_name: str | None = None
    # "" = not chosen yet; the UI then follows OS-locale detection.
    language: str = ""
    onboarding_completed: bool = False
    unrestricted_mode: bool = False
    # "auto" — use WSL if available, fall back to PowerShell on Windows.
    # "wsl" — force WSL (errors if missing). "powershell" — force PowerShell.
    shell_preference: str = "auto"
    # When true the backend binds 0.0.0.0 (reachable from other devices) and
    # requires a Bearer token for every non-loopback /api request. The token
    # itself is NOT exposed here — read it from the loopback-only
    # GET /api/remote-access endpoint.
    remote_access_enabled: bool = False
    # Default web search mode offered in the UI (auto|native|litellm|searxng).
    web_search_mode: str = "auto"
    # Sticky on/off state of the web-search toggle. Persisted here (not in
    # localStorage) so it survives app restarts and is shared across devices.
    web_search_enabled: bool = False
    # Optional self-hosted SearXNG base URL. Overrides the SEARXNG_URL env var.
    searxng_url: str | None = None
    # True when a Tavily key is configured (settings or TAVILY_API_KEY env). The
    # raw key is never returned — set it via SettingsUpdate.tavily_api_key.
    tavily_api_key_set: bool = False
    # Sticky on/off state of the per-chat research toggle. Persisted (like
    # web_search_enabled) so it survives restarts and is shared across devices.
    research_enabled: bool = False
    # Model the inner research loop runs on. "" → fall back to default_model.
    research_model: str = ""
    # User keyboard shortcuts: action id → normalized combo (e.g. "Mod+N").
    # Empty/missing entries fall back to the frontend's built-in defaults.
    shortcuts: dict[str, str] = Field(default_factory=dict)
    mcp_servers: list[MCPServerConfig] = Field(default_factory=list)
    # When true, tool schemas expose an optional `activity` field and the
    # system prompt asks the model to narrate each call in its own words —
    # the UI shows that instead of the generic system-written status line.
    describe_actions: bool = False


class SettingsUpdate(BaseModel):
    default_model: str | None = None
    temperature: float | None = None
    max_iterations: int | None = None
    user_name: str | None = None
    theme: str | None = None
    notify_sound: bool | None = None
    # Empty string clears the custom sound (reverts to the chime); None = unchanged.
    notify_sound_data: str | None = None
    notify_sound_name: str | None = None
    language: str | None = None
    onboarding_completed: bool | None = None
    unrestricted_mode: bool | None = None
    shell_preference: str | None = None
    remote_access_enabled: bool | None = None
    web_search_mode: str | None = None
    web_search_enabled: bool | None = None
    searxng_url: str | None = None
    # Empty string clears the stored key (falls back to TAVILY_API_KEY env).
    tavily_api_key: str | None = None
    research_enabled: bool | None = None
    # Empty string → fall back to default_model for research.
    research_model: str | None = None
    # Full replacement of the keyboard-shortcut map (action id → combo).
    shortcuts: dict[str, str] | None = None
    describe_actions: bool | None = None


class ProviderUpdate(BaseModel):
    api_key: str | None = None
    api_base: str | None = None
    enabled: bool | None = None
    extra_headers: dict[str, str] | None = None


class RemoteAccessInfo(BaseModel):
    """Pairing info for connecting a phone to this backend.

    Served only to loopback clients (the desktop app) so the token is never
    handed to a remote caller.
    """

    enabled: bool
    token: str
    port: int
    # Best-effort http://<ip>:<port> candidates (LAN, and Tailscale when found).
    urls: list[str] = Field(default_factory=list)
