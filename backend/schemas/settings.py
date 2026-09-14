from __future__ import annotations

from pydantic import BaseModel, Field

from schemas.mcp import MCPServerConfig
from schemas.redaction import redact_map


class ModelConfig(BaseModel):
    id: str
    name: str | None = None
    thinking: bool | None = None
    thinking_types: list[str] | None = None
    effort_levels: list[str] | None = None
    # Native web-search capability, when the provider's models API reports it.
    web_search: bool | None = None


class ProviderConfig(BaseModel):
    """Internal provider record — carries the raw key.

    Never serialize this to an HTTP response; use :class:`ProviderPublic`.
    The key itself lives in the SecretStore, not in settings.json, and is
    rehydrated into this model at load time (see store/settings_io.py).
    """

    id: str
    name: str
    api_key: str | None = None
    api_base: str | None = None
    enabled: bool = True
    api_key_set: bool = False
    custom: bool = False
    extra_headers: dict[str, str] | None = None


class ProviderPublic(BaseModel):
    """Provider as exposed over the API — the raw key is absent, not masked.

    The UI only ever needed ``api_key_set`` (see ProvidersTab), so dropping the
    key costs nothing and keeps it off the wire in remote mode, where the
    backend speaks plain HTTP.
    """

    id: str
    name: str
    api_base: str | None = None
    enabled: bool = True
    api_key_set: bool = False
    custom: bool = False
    # Header names visible, values masked — see schemas.redaction.
    extra_headers: dict[str, str] | None = None
    # False for local servers that answer without credentials — the UI stops
    # nagging for a key instead of asking the user to invent one.
    key_required: bool = True
    # The api_base this provider shipped with, so the UI can offer a way back
    # from a bad edit. None for custom providers (they never had one).
    default_api_base: str | None = None

    @classmethod
    def from_config(
        cls,
        p: ProviderConfig,
        *,
        key_required: bool = True,
        default_api_base: str | None = None,
    ) -> ProviderPublic:
        return cls(
            id=p.id,
            name=p.name,
            api_base=p.api_base,
            enabled=p.enabled,
            # Derived from the secret actually present rather than the
            # persisted flag, so a wiped keychain shows up as "no key" instead
            # of a phantom checkmark.
            api_key_set=bool(p.api_key),
            custom=p.custom,
            extra_headers=redact_map(p.extra_headers),
            key_required=key_required,
            default_api_base=default_api_base,
        )


class ProviderCreate(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9_\-]+$")
    name: str = Field(min_length=1)
    api_base: str = Field(min_length=1)
    api_key: str | None = None
    extra_headers: dict[str, str] | None = None


class SettingsData(BaseModel):
    providers: list[ProviderPublic] = Field(default_factory=list)
    models: list[ModelConfig] = Field(default_factory=list)
    default_model: str = "openai/gpt-4o"
    temperature: float = 0.7
    max_iterations: int = 50
    user_name: str = "AgentChat"
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
    # Which renderer image_generate uses: auto|api|a1111|comfy. "auto" prefers a
    # configured local GPU over a paid API — see images/config.AUTO_ORDER.
    image_backend: str = "auto"
    # "<provider>/<model>" for the hosted image backend, e.g. "openai/gpt-image-1".
    # Empty means the hosted backend is unavailable.
    image_api_model: str = ""
    # Base URL of a local AUTOMATIC1111-compatible server (A1111 / Forge / SD.Next).
    a1111_url: str | None = None
    # Base URL of a local ComfyUI server.
    comfy_url: str | None = None
    # Checkpoint filename as ComfyUI knows it. Empty → whatever the workflow
    # names, else ComfyUI's first installed checkpoint.
    comfy_checkpoint: str = ""
    # Path to a user-exported ComfyUI workflow (API format) replacing the bundled one.
    comfy_workflow_path: str | None = None
    # Sticky on/off state of the per-chat research toggle. Persisted (like
    # web_search_enabled) so it survives restarts and is shared across devices.
    research_enabled: bool = False
    # Model the lead researcher runs on. "" → fall back to default_model.
    research_lead_model: str = ""
    # Model the parallel research subagents run on — where most of a run's tokens
    # go. "" → fall back to the lead's model.
    research_worker_model: str = ""
    # User keyboard shortcuts: action id → normalized combo (e.g. "Mod+N").
    # Empty/missing entries fall back to the frontend's built-in defaults.
    shortcuts: dict[str, str] = Field(default_factory=dict)
    # Values inside each server's env/headers are masked — see
    # schemas.redaction. Sending a masked value back keeps the stored one.
    mcp_servers: list[MCPServerConfig] = Field(default_factory=list)
    # Where API keys actually ended up: "keyring" (OS credential store),
    # "file" (0600 plaintext fallback — no keychain reachable) or "memory".
    # Surfaced so the user isn't left assuming encryption they didn't get.
    secret_backend: str = "file"
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
    image_backend: str | None = None
    # Empty string disables the hosted image backend.
    image_api_model: str | None = None
    a1111_url: str | None = None
    comfy_url: str | None = None
    comfy_checkpoint: str | None = None
    comfy_workflow_path: str | None = None
    research_enabled: bool | None = None
    # Empty string → fall back to default_model for the research lead.
    research_lead_model: str | None = None
    # Empty string → research subagents run on the lead's model.
    research_worker_model: str | None = None
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
