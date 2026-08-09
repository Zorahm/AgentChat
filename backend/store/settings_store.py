"""Persistent settings store + built-in provider catalogue.

Owns everything settings-related: the default provider list, env-key
resolution, the JSON-backed :class:`SettingsStore`, and the per-request web
search config derived from it. Imports only schemas/services (never the API
route layer), so it sits below the app factory in the dependency graph.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

import server_mode
from images.config import ImageGenConfig
from llm.api_base import requires_api_key
from llm.model_tag import retag_model_for_litellm
from llm.models_fetcher import ModelsFetcher, looks_thinking
from paths import SEARXNG_URL_ENV, TAVILY_API_KEY
from schemas.agents import DEFAULT_AGENT_ID, AgentConfig, AgentCreate, AgentUpdate
from schemas.mcp import (
    MCP_SECRET_FIELDS,
    MCPServerConfig,
    MCPServerUpdate,
    redact_mcp_server,
)
from schemas.redaction import redact_map, unredact_map
from schemas.settings import (
    ModelConfig,
    ProviderConfig,
    ProviderCreate,
    ProviderPublic,
    ProviderUpdate,
    SettingsData,
    SettingsUpdate,
)
from store.secret_store import SecretStore
from store.settings_io import (
    merge_secrets,
    read_settings_file,
    split_secrets,
    write_settings_file,
)
from web_search.config import WebSearchConfig

# Accepted values of the image_backend setting. Kept as a plain tuple rather
# than imported from images.config so validation here needs no typing.get_args.
IMAGE_BACKENDS = ("auto", "api", "a1111", "comfy")

# ---------------------------------------------------------------------------
# default providers
# ---------------------------------------------------------------------------

DEFAULT_PROVIDERS: list[ProviderConfig] = [
    ProviderConfig(id="openai", name="OpenAI", api_base="https://api.openai.com/v1"),
    ProviderConfig(id="anthropic", name="Anthropic", api_base="https://api.anthropic.com"),
    ProviderConfig(id="gemini", name="Google Gemini", api_base="https://generativelanguage.googleapis.com/v1beta/openai/"),
    ProviderConfig(id="deepseek", name="DeepSeek", api_base="https://api.deepseek.com/v1"),
    ProviderConfig(
        id="openrouter", name="OpenRouter", api_base="https://openrouter.ai/api/v1"
    ),
    ProviderConfig(
        id="yandex",
        name="Yandex AI Studio",
        api_base="https://ai.api.cloud.yandex.net/v1",
    ),
    ProviderConfig(
        id="opencode",
        name="OpenCode Go",
        api_base="https://opencode.ai/zen/go/v1",
    ),
]


# The URL each built-in shipped with. Kept so the UI can offer "reset to
# default" once the user is free to edit api_base.
DEFAULT_API_BASES: dict[str, str] = {
    p.id: p.api_base for p in DEFAULT_PROVIDERS if p.api_base
}


def to_public(p: ProviderConfig) -> ProviderPublic:
    """Public view of a provider, with the UI-only hints filled in."""
    return ProviderPublic.from_config(
        p,
        key_required=requires_api_key(p.id, p.api_base),
        default_api_base=DEFAULT_API_BASES.get(p.id),
    )


def _resolve_env_api_key(provider_id: str) -> str | None:
    """Check well-known env vars for a provider's API key."""
    env_map: dict[str, str] = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "yandex": "YANDEX_API_KEY",
        "groq": "GROQ_API_KEY",
        "mistral": "MISTRAL_API_KEY",
        "cohere": "COHERE_API_KEY",
        "together": "TOGETHER_API_KEY",
    }
    key = env_map.get(provider_id)
    if key:
        return os.environ.get(key)
    return None


def _migrate_agent(raw: dict[str, Any]) -> dict[str, Any]:
    """Bring a persisted agent up to the current schema.

    Before prompt modes, a non-empty ``system_prompt`` always meant "replace the
    whole built-in prompt". Defaulting those records to the new ``append`` mode
    would silently change what every existing agent does, so records written
    before the field existed are pinned to ``replace``.
    """
    if "prompt_mode" in raw:
        return raw
    legacy_override = bool(str(raw.get("system_prompt", "")).strip())
    return {**raw, "prompt_mode": "replace" if legacy_override else "append"}


# ---------------------------------------------------------------------------
# settings store
# ---------------------------------------------------------------------------


class SettingsStore:
    """Persistent settings store backed by a JSON file.

    Models are not persisted — they're discovered live by ``ModelsFetcher``
    via each provider's ``/models`` endpoint. Secrets are not persisted here
    either: they live in a :class:`SecretStore` and are merged back into the
    in-memory models on load (see ``store.settings_io``).
    """

    def __init__(
        self,
        fetcher: ModelsFetcher | None = None,
        settings_path: Path | None = None,
        secret_store: SecretStore | None = None,
    ) -> None:
        # Default to a file-backed store beside settings.json. It deliberately
        # does NOT reach for the OS keychain: only the composition root
        # (main.create_app) opts into that, so tests and embedders never write
        # into the developer's real credential store.
        self._secrets = secret_store or SecretStore(
            settings_path.parent / "secrets.json" if settings_path else None
        )
        self._providers: dict[str, ProviderConfig] = {}
        self._mcp_servers: dict[str, MCPServerConfig] = {}
        self._agents: dict[str, AgentConfig] = {
            DEFAULT_AGENT_ID: AgentConfig(id=DEFAULT_AGENT_ID, name="AgentChat"),
        }
        self._fetcher = fetcher
        self._settings_path = settings_path
        self._default_model = os.environ.get("AGENT_MODEL", "openai/gpt-4o")
        self._temperature = 0.7
        self._max_iterations = 50
        self._user_name = ""
        self._theme = "system"
        self._notify_sound = False
        self._notify_sound_data: str | None = None
        self._notify_sound_name: str | None = None
        self._language = ""
        self._onboarding_completed = False
        self._unrestricted_mode = False
        self._shell_preference = "auto"
        self._remote_access_enabled = False
        self._web_search_mode = "auto"
        self._web_search_enabled = False
        # None → fall back to the SEARXNG_URL env var at request time.
        self._searxng_url: str | None = None
        # None → fall back to the TAVILY_API_KEY env var at request time.
        self._tavily_api_key: str | None = None
        # Image generation. The hosted model reuses an existing provider's key,
        # so unlike Tavily there is no secret of its own to store here.
        self._image_backend = "auto"
        self._image_api_model = ""
        self._a1111_url: str | None = None
        self._comfy_url: str | None = None
        self._comfy_checkpoint = ""
        self._comfy_workflow_path: str | None = None
        # Sticky research toggle + the two models a research run uses: the lead
        # plans and synthesizes, the workers do the parallel digging. Splitting
        # them matters because the workers are where the tokens actually go.
        # "" → fall back to default_model.
        self._research_enabled = False
        self._research_lead_model = ""
        self._research_worker_model = ""
        # Long-lived shared secret for remote (phone) access. Generated lazily
        # the first time remote access is enabled; persisted in settings.json.
        self._remote_token = ""
        # Keyboard shortcuts: action id → normalized combo. Empty means the
        # frontend uses its built-in defaults for every action.
        self._shortcuts: dict[str, str] = {}
        # Off by default: model writes its own one-line action descriptions
        # instead of the system-computed status line.
        self._describe_actions = False

        # 1. Seed every built-in provider with env-resolved API keys.
        for p in DEFAULT_PROVIDERS:
            provider = p.model_copy()
            env_key = _resolve_env_api_key(provider.id)
            if env_key and not provider.api_key:
                provider.api_key = env_key
                provider.api_key_set = True
            self._providers[provider.id] = provider

        # 2. Overlay anything previously saved to disk.
        self._load()

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Read settings.json and overlay onto the in-memory defaults.

        Parsing and secret rehydration live in ``store.settings_io``; what
        stays here is the per-field type checking that decides which saved
        values are trustworthy enough to replace a default.
        """
        data = read_settings_file(self._settings_path)
        if not data:
            return
        data, needs_migration = merge_secrets(data, self._secrets)

        global_block = data.get("global", {})
        if isinstance(global_block, dict):
            dm = global_block.get("default_model")
            if isinstance(dm, str):
                self._default_model = dm
            temp = global_block.get("temperature")
            if isinstance(temp, (int, float)):
                self._temperature = float(temp)
            mi = global_block.get("max_iterations")
            if isinstance(mi, int):
                self._max_iterations = mi
            un = global_block.get("user_name")
            if isinstance(un, str):
                self._user_name = un
            th = global_block.get("theme")
            if isinstance(th, str):
                self._theme = th
            ns = global_block.get("notify_sound")
            if isinstance(ns, bool):
                self._notify_sound = ns
            nsd = global_block.get("notify_sound_data")
            if isinstance(nsd, str):
                self._notify_sound_data = nsd or None
            nsn = global_block.get("notify_sound_name")
            if isinstance(nsn, str):
                self._notify_sound_name = nsn or None
            lang = global_block.get("language")
            if isinstance(lang, str):
                self._language = lang
            ob = global_block.get("onboarding_completed")
            if isinstance(ob, bool):
                self._onboarding_completed = ob
            ur = global_block.get("unrestricted_mode")
            if isinstance(ur, bool):
                self._unrestricted_mode = ur
            sp = global_block.get("shell_preference")
            if isinstance(sp, str) and sp in ("auto", "wsl", "powershell", "zsh"):
                self._shell_preference = sp
            ra = global_block.get("remote_access_enabled")
            if isinstance(ra, bool):
                self._remote_access_enabled = ra
            rt = global_block.get("remote_token")
            if isinstance(rt, str):
                self._remote_token = rt
            wsm = global_block.get("web_search_mode")
            if isinstance(wsm, str) and wsm in ("auto", "native", "litellm", "searxng"):
                self._web_search_mode = wsm
            wse = global_block.get("web_search_enabled")
            if isinstance(wse, bool):
                self._web_search_enabled = wse
            sx = global_block.get("searxng_url")
            if isinstance(sx, str):
                self._searxng_url = sx or None
            tav = global_block.get("tavily_api_key")
            if isinstance(tav, str):
                self._tavily_api_key = tav or None
            ib = global_block.get("image_backend")
            if isinstance(ib, str) and ib in IMAGE_BACKENDS:
                self._image_backend = ib
            iam = global_block.get("image_api_model")
            if isinstance(iam, str):
                self._image_api_model = iam
            a1111 = global_block.get("a1111_url")
            if isinstance(a1111, str):
                self._a1111_url = a1111 or None
            comfy = global_block.get("comfy_url")
            if isinstance(comfy, str):
                self._comfy_url = comfy or None
            ckpt = global_block.get("comfy_checkpoint")
            if isinstance(ckpt, str):
                self._comfy_checkpoint = ckpt
            wf = global_block.get("comfy_workflow_path")
            if isinstance(wf, str):
                self._comfy_workflow_path = wf or None
            re_ = global_block.get("research_enabled")
            if isinstance(re_, bool):
                self._research_enabled = re_
            # `research_model` is the pre-split single setting; it seeds the lead
            # so an upgraded install keeps researching on the model it was told to.
            legacy_model = global_block.get("research_model")
            if isinstance(legacy_model, str):
                self._research_lead_model = legacy_model
            lead_model = global_block.get("research_lead_model")
            if isinstance(lead_model, str):
                self._research_lead_model = lead_model
            worker_model = global_block.get("research_worker_model")
            if isinstance(worker_model, str):
                self._research_worker_model = worker_model
            sc = global_block.get("shortcuts")
            if isinstance(sc, dict):
                self._shortcuts = {
                    str(k): str(v) for k, v in sc.items() if isinstance(v, str)
                }
            da = global_block.get("describe_actions")
            if isinstance(da, bool):
                self._describe_actions = da

        providers_block = data.get("providers", [])
        if isinstance(providers_block, list):
            for raw_p in providers_block:
                if not isinstance(raw_p, dict) or "id" not in raw_p:
                    continue
                try:
                    saved = ProviderConfig.model_validate(raw_p)
                except Exception as exc:  # noqa: BLE001
                    # Log the id only — the raw dict carries the API key.
                    print(f"[settings] skipping malformed provider {raw_p.get('id')!r}: {exc}")
                    continue
                existing = self._providers.get(saved.id)
                if existing is None:
                    # Custom provider added by the user in a previous session.
                    self._providers[saved.id] = saved
                else:
                    # Built-in: keep id/name/custom from defaults, take user fields
                    # from disk (but don't drop a working env-resolved key when
                    # the file has none).
                    if saved.api_key:
                        existing.api_key = saved.api_key
                        existing.api_key_set = True
                    if saved.api_base:
                        existing.api_base = saved.api_base
                    existing.enabled = saved.enabled
                    if saved.extra_headers:
                        existing.extra_headers = saved.extra_headers

        mcp_block = data.get("mcp", {})
        if isinstance(mcp_block, dict):
            raw_servers = mcp_block.get("servers", [])
            if isinstance(raw_servers, list):
                for raw_s in raw_servers:
                    if not isinstance(raw_s, dict) or "id" not in raw_s:
                        continue
                    try:
                        server = MCPServerConfig.model_validate(raw_s)
                    except Exception as exc:  # noqa: BLE001
                        # Log the id only — env/headers carry credentials.
                        print(
                            f"[settings] skipping malformed mcp server "
                            f"{raw_s.get('id')!r}: {exc}"
                        )
                        continue
                    self._mcp_servers[server.id] = server

        agents_block = data.get("agents", [])
        if isinstance(agents_block, list):
            for raw_a in agents_block:
                if not isinstance(raw_a, dict) or "id" not in raw_a:
                    continue
                try:
                    agent = AgentConfig.model_validate(_migrate_agent(raw_a))
                except Exception as exc:  # noqa: BLE001
                    print(f"[settings] skipping malformed agent {raw_a.get('id')!r}: {exc}")
                    continue
                self._agents[agent.id] = agent

        if needs_migration:
            # The file still held secrets inline (pre-upgrade layout). Saving
            # now hands them to the SecretStore and rewrites settings.json
            # without them. Idempotent: the next start finds nothing to move.
            print("[settings] migrating secrets out of settings.json")
            self._save()

    def _save(self) -> None:
        """Persist current state: secrets to the SecretStore, the rest to JSON."""
        if self._settings_path is None:
            return
        payload = {
            "global": {
                "default_model": self._default_model,
                "temperature": self._temperature,
                "max_iterations": self._max_iterations,
                "user_name": self._user_name,
                "theme": self._theme,
                "notify_sound": self._notify_sound,
                "notify_sound_data": self._notify_sound_data,
                "notify_sound_name": self._notify_sound_name,
                "language": self._language,
                "onboarding_completed": self._onboarding_completed,
                "unrestricted_mode": self._unrestricted_mode,
                "shell_preference": self._shell_preference,
                "remote_access_enabled": self._remote_access_enabled,
                "remote_token": self._remote_token,
                "web_search_mode": self._web_search_mode,
                "web_search_enabled": self._web_search_enabled,
                "searxng_url": self._searxng_url,
                "tavily_api_key": self._tavily_api_key,
                "image_backend": self._image_backend,
                "image_api_model": self._image_api_model,
                "a1111_url": self._a1111_url,
                "comfy_url": self._comfy_url,
                "comfy_checkpoint": self._comfy_checkpoint,
                "comfy_workflow_path": self._comfy_workflow_path,
                "research_enabled": self._research_enabled,
                "research_lead_model": self._research_lead_model,
                "research_worker_model": self._research_worker_model,
                "shortcuts": self._shortcuts,
                "describe_actions": self._describe_actions,
            },
            "providers": [
                p.model_dump() for p in sorted(self._providers.values(), key=lambda x: x.id)
            ],
            "mcp": {
                "servers": [
                    s.model_dump()
                    for s in sorted(self._mcp_servers.values(), key=lambda x: x.id)
                ],
            },
            "agents": [
                a.model_dump() for a in sorted(self._agents.values(), key=lambda x: x.id)
            ],
        }
        write_settings_file(self._settings_path, split_secrets(payload, self._secrets))

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def get(self) -> SettingsData:
        """Build the API-facing view. No secret crosses this boundary."""
        return SettingsData(
            providers=[
                to_public(p) for p in sorted(self._providers.values(), key=lambda p: p.id)
            ],
            models=[],
            default_model=self._default_model,
            temperature=self._temperature,
            max_iterations=self._max_iterations,
            user_name=self._user_name,
            theme=self._theme,
            notify_sound=self._notify_sound,
            notify_sound_data=self._notify_sound_data,
            notify_sound_name=self._notify_sound_name,
            language=self._language,
            onboarding_completed=self._onboarding_completed,
            unrestricted_mode=self._unrestricted_mode,
            shell_preference=self._shell_preference,
            remote_access_enabled=self.remote_access_enabled,
            web_search_mode=self._web_search_mode,
            web_search_enabled=self._web_search_enabled,
            searxng_url=self._searxng_url,
            tavily_api_key_set=bool(self._tavily_api_key or TAVILY_API_KEY),
            image_backend=self._image_backend,
            image_api_model=self._image_api_model,
            a1111_url=self._a1111_url,
            comfy_url=self._comfy_url,
            comfy_checkpoint=self._comfy_checkpoint,
            comfy_workflow_path=self._comfy_workflow_path,
            research_enabled=self._research_enabled,
            research_lead_model=self._research_lead_model,
            research_worker_model=self._research_worker_model,
            shortcuts=dict(self._shortcuts),
            mcp_servers=[
                redact_mcp_server(s)
                for s in sorted(self._mcp_servers.values(), key=lambda s: s.id)
            ],
            describe_actions=self._describe_actions,
            secret_backend=self._secrets.backend,
        )

    def update(self, patch: SettingsUpdate) -> SettingsData:
        if patch.default_model is not None:
            self._default_model = patch.default_model
        if patch.temperature is not None:
            self._temperature = patch.temperature
        if patch.max_iterations is not None:
            self._max_iterations = patch.max_iterations
        if patch.user_name is not None:
            self._user_name = patch.user_name
        if patch.theme is not None:
            self._theme = patch.theme
        if patch.notify_sound is not None:
            self._notify_sound = patch.notify_sound
        if patch.notify_sound_data is not None:
            # Empty string clears the custom sound (revert to the chime).
            self._notify_sound_data = patch.notify_sound_data or None
        if patch.notify_sound_name is not None:
            self._notify_sound_name = patch.notify_sound_name or None
        if patch.language is not None:
            self._language = patch.language
        if patch.onboarding_completed is not None:
            self._onboarding_completed = patch.onboarding_completed
        if patch.unrestricted_mode is not None:
            self._unrestricted_mode = patch.unrestricted_mode
        if patch.shell_preference is not None:
            if patch.shell_preference not in ("auto", "wsl", "powershell", "zsh"):
                raise ValueError(
                    f"shell_preference must be one of auto|wsl|powershell|zsh, got {patch.shell_preference!r}"
                )
            self._shell_preference = patch.shell_preference
        if patch.remote_access_enabled is not None:
            self._remote_access_enabled = patch.remote_access_enabled
            # Mint a token the first time remote access is switched on; reuse it
            # afterwards so paired phones keep working across toggles.
            if patch.remote_access_enabled and not self._remote_token:
                self._remote_token = secrets.token_urlsafe(32)
        if patch.web_search_mode is not None:
            if patch.web_search_mode not in ("auto", "native", "litellm", "searxng"):
                raise ValueError(
                    "web_search_mode must be one of auto|native|litellm|searxng, "
                    f"got {patch.web_search_mode!r}"
                )
            self._web_search_mode = patch.web_search_mode
        if patch.web_search_enabled is not None:
            self._web_search_enabled = patch.web_search_enabled
        if patch.searxng_url is not None:
            self._searxng_url = patch.searxng_url.strip() or None
        if patch.tavily_api_key is not None:
            self._tavily_api_key = patch.tavily_api_key.strip() or None
        if patch.image_backend is not None:
            if patch.image_backend not in IMAGE_BACKENDS:
                raise ValueError(
                    "image_backend must be one of "
                    f"{'|'.join(IMAGE_BACKENDS)}, got {patch.image_backend!r}"
                )
            self._image_backend = patch.image_backend
        if patch.image_api_model is not None:
            self._image_api_model = patch.image_api_model.strip()
        if patch.a1111_url is not None:
            self._a1111_url = patch.a1111_url.strip() or None
        if patch.comfy_url is not None:
            self._comfy_url = patch.comfy_url.strip() or None
        if patch.comfy_checkpoint is not None:
            self._comfy_checkpoint = patch.comfy_checkpoint.strip()
        if patch.comfy_workflow_path is not None:
            self._comfy_workflow_path = patch.comfy_workflow_path.strip() or None
        if patch.research_enabled is not None:
            self._research_enabled = patch.research_enabled
        if patch.research_lead_model is not None:
            self._research_lead_model = patch.research_lead_model.strip()
        if patch.research_worker_model is not None:
            self._research_worker_model = patch.research_worker_model.strip()
        if patch.shortcuts is not None:
            # Full replacement; drop blank combos so they fall back to defaults.
            self._shortcuts = {
                str(k): v for k, v in patch.shortcuts.items() if isinstance(v, str) and v
            }
        if patch.describe_actions is not None:
            self._describe_actions = patch.describe_actions
        self._save()
        return self.get()

    def rotate_remote_token(self) -> str:
        """Mint a fresh remote-access token and return it.

        Every paired phone stops working immediately — that is the point of
        the button. Enabling/disabling remote access deliberately reuses the
        existing token, so this is the only way to revoke one.
        """
        self._remote_token = secrets.token_urlsafe(32)
        self._save()
        return self._remote_token

    def update_provider(self, provider_id: str, patch: ProviderUpdate) -> ProviderConfig:
        if provider_id not in self._providers:
            raise ValueError(f"Unknown provider: {provider_id}")
        p = self._providers[provider_id]
        if patch.api_key is not None:
            p.api_key = patch.api_key if patch.api_key else None
            p.api_key_set = bool(patch.api_key)
        if patch.api_base is not None:
            base = patch.api_base.strip()
            p.api_base = base or None
        if patch.enabled is not None:
            p.enabled = patch.enabled
        if patch.extra_headers is not None:
            # The client only ever saw masked values, so resolve those back to
            # what is stored; anything else is a real edit.
            resolved = unredact_map(patch.extra_headers, p.extra_headers)
            p.extra_headers = dict(resolved) if resolved else None
        self._save()
        return p.model_copy()

    def add_provider(self, body: ProviderCreate) -> ProviderConfig:
        if body.id in self._providers:
            raise ValueError(f"Provider '{body.id}' already exists")
        provider = ProviderConfig(
            id=body.id,
            name=body.name,
            api_base=body.api_base.rstrip("/"),
            api_key=body.api_key or None,
            api_key_set=bool(body.api_key),
            enabled=True,
            custom=True,
            extra_headers=dict(body.extra_headers) if body.extra_headers else None,
        )
        self._providers[provider.id] = provider
        self._save()
        return provider.model_copy()

    def remove_provider(self, provider_id: str) -> None:
        p = self._providers.get(provider_id)
        if p is None:
            raise ValueError(f"Unknown provider: {provider_id}")
        if not p.custom:
            raise ValueError(f"Provider '{provider_id}' is built-in and cannot be removed")
        del self._providers[provider_id]
        # _save only clears secrets for ids still in the payload, so a deleted
        # provider's key has to be dropped explicitly or it lingers in the
        # keychain forever.
        self._secrets.set(f"provider:{provider_id}", None)
        self._save()

    def list_providers(self) -> list[ProviderConfig]:
        return [p.model_copy() for p in self._providers.values()]

    # ------------------------------------------------------------------
    # mcp servers
    # ------------------------------------------------------------------

    def list_mcp_servers(self) -> list[MCPServerConfig]:
        return [s.model_copy(deep=True) for s in sorted(self._mcp_servers.values(), key=lambda x: x.id)]

    def get_mcp_server(self, server_id: str) -> MCPServerConfig | None:
        s = self._mcp_servers.get(server_id)
        return s.model_copy(deep=True) if s is not None else None

    def add_mcp_server(self, cfg: MCPServerConfig) -> MCPServerConfig:
        if cfg.id in self._mcp_servers:
            raise ValueError(f"MCP server '{cfg.id}' already exists")
        self._mcp_servers[cfg.id] = cfg.model_copy(deep=True)
        self._save()
        return cfg.model_copy(deep=True)

    def update_mcp_server(
        self, server_id: str, patch: MCPServerUpdate
    ) -> MCPServerConfig:
        existing = self._mcp_servers.get(server_id)
        if existing is None:
            raise ValueError(f"Unknown MCP server: {server_id}")
        if patch.name is not None:
            existing.name = patch.name
        if patch.enabled is not None:
            existing.enabled = patch.enabled
        if patch.config is not None:
            # Same masked round-trip as provider headers — but only when the
            # transport is unchanged, since env/headers from a different
            # transport describe a different thing entirely.
            incoming = patch.config.model_copy(deep=True)
            if incoming.transport == existing.config.transport:
                for field in MCP_SECRET_FIELDS:
                    current = getattr(incoming, field, None)
                    if isinstance(current, dict):
                        resolved = unredact_map(current, getattr(existing.config, field, None))
                        setattr(incoming, field, dict(resolved) if resolved else {})
            existing.config = incoming
        self._save()
        return existing.model_copy(deep=True)

    def remove_mcp_server(self, server_id: str) -> None:
        if server_id not in self._mcp_servers:
            raise ValueError(f"Unknown MCP server: {server_id}")
        del self._mcp_servers[server_id]
        self._secrets.set(f"mcp:{server_id}", None)
        self._save()

    def upsert_mcp_server(self, cfg: MCPServerConfig) -> None:
        """Insert or replace — used by the bulk import endpoint."""
        self._mcp_servers[cfg.id] = cfg.model_copy(deep=True)
        self._save()

    # ------------------------------------------------------------------
    # agents
    # ------------------------------------------------------------------

    def list_agents(self) -> list[AgentConfig]:
        return [a.model_copy() for a in sorted(self._agents.values(), key=lambda a: a.id)]

    def get_agent(self, agent_id: str) -> AgentConfig | None:
        a = self._agents.get(agent_id)
        return a.model_copy() if a is not None else None

    def add_agent(self, body: AgentCreate) -> AgentConfig:
        """``AgentCreate`` and ``AgentConfig`` share ``AgentFields``, so the
        record copies across wholesale — no per-field list to forget to extend.
        """
        if body.id in self._agents:
            raise ValueError(f"Agent '{body.id}' already exists")
        agent = AgentConfig.model_validate(body.model_dump())
        self._agents[agent.id] = agent
        self._save()
        return agent.model_copy()

    def update_agent(self, agent_id: str, patch: AgentUpdate) -> AgentConfig:
        """Merge *patch* onto the stored record and re-validate the result.

        ``exclude_unset`` is what distinguishes "not sent" from "sent as null":
        the first leaves a field alone, the second applies — which is the only
        way ``temperature`` can be handed back to the global setting. Merging
        and re-validating (rather than assigning field by field) also means the
        cross-field rules in ``AgentFields`` run on every edit, so a patch can
        never write a record that fails to load on the next boot.

        The resulting ``ValidationError`` is a ``ValueError`` subclass; the
        route catches it first and answers 400, leaving plain ``ValueError``
        to mean "no such agent".
        """
        if agent_id == DEFAULT_AGENT_ID:
            raise PermissionError("The default agent cannot be edited")
        agent = self._agents.get(agent_id)
        if agent is None:
            raise ValueError(f"Unknown agent: {agent_id}")
        merged = AgentConfig.model_validate(
            {**agent.model_dump(), **patch.model_dump(exclude_unset=True)}
        )
        self._agents[agent_id] = merged
        self._save()
        return merged.model_copy()

    def remove_agent(self, agent_id: str) -> None:
        if agent_id == DEFAULT_AGENT_ID:
            raise ValueError("The default agent cannot be deleted")
        if agent_id not in self._agents:
            raise ValueError(f"Unknown agent: {agent_id}")
        del self._agents[agent_id]
        self._save()

    def get_provider(self, model: str) -> ProviderConfig | None:
        """Resolve a provider by model string (prefix before /)."""
        if "/" in model:
            prefix = model.split("/", 1)[0]
        else:
            prefix = model
        return self._providers.get(prefix)

    def get_model_config(self, model: str) -> ModelConfig | None:
        """Look up a model — checks fetcher cache first, falls back to heuristic."""
        if self._fetcher is not None:
            cached = self._fetcher.get_cached_model(model)
            if cached is not None:
                return cached
        # fallback: derive thinking flag from id alone
        bare = model.split("/", 1)[-1]
        return ModelConfig(
            id=model,
            name=bare,
            thinking=True if looks_thinking(bare) else None,
        )

    @property
    def default_model(self) -> str:
        return self._default_model

    @property
    def temperature(self) -> float:
        return self._temperature

    @property
    def max_iterations(self) -> int:
        return self._max_iterations

    @property
    def user_name(self) -> str:
        return self._user_name

    @property
    def language(self) -> str:
        """UI language code, or "" when the user never picked one.

        Read by prompt assembly for the ``{lang}`` persona variable — the app
        does not otherwise tell the model which language the interface is in.
        """
        return self._language

    @property
    def theme(self) -> str:
        return self._theme

    @property
    def onboarding_completed(self) -> bool:
        return self._onboarding_completed

    @property
    def unrestricted_mode(self) -> bool:
        return self._unrestricted_mode

    @property
    def web_search_mode(self) -> str:
        return self._web_search_mode

    @property
    def searxng_url(self) -> str | None:
        return self._searxng_url

    @property
    def research_enabled(self) -> bool:
        return self._research_enabled

    @property
    def research_lead_model(self) -> str:
        return self._research_lead_model

    @property
    def research_worker_model(self) -> str:
        """Model for the parallel subagents. "" → the lead's model."""
        return self._research_worker_model or self._research_lead_model

    @property
    def tavily_api_key(self) -> str | None:
        return self._tavily_api_key

    @property
    def image_backend(self) -> str:
        return self._image_backend

    @property
    def image_api_model(self) -> str:
        return self._image_api_model

    @property
    def a1111_url(self) -> str | None:
        return self._a1111_url

    @property
    def comfy_url(self) -> str | None:
        return self._comfy_url

    @property
    def comfy_checkpoint(self) -> str:
        return self._comfy_checkpoint

    @property
    def comfy_workflow_path(self) -> str | None:
        return self._comfy_workflow_path

    @property
    def shell_preference(self) -> str:
        return self._shell_preference

    @property
    def remote_access_enabled(self) -> bool:
        # A server-mode backend is remote by definition — there is no desktop
        # app alongside it to flip the stored toggle.
        return True if server_mode.enabled() else self._remote_access_enabled

    @property
    def remote_token(self) -> str:
        # In server mode the secret lives in the environment or a 0600 file,
        # never in settings.json: the server has no keychain to protect it and
        # no UI to rotate it from.
        return server_mode.server_token() if server_mode.enabled() else self._remote_token

    @property
    def secret_backend(self) -> str:
        """Which storage the secrets ended up in — surfaced in Settings so the
        user can tell an encrypted keychain from the plaintext fallback."""
        return self._secrets.backend

    @property
    def describe_actions(self) -> bool:
        return self._describe_actions


def build_web_search_config(store: SettingsStore) -> WebSearchConfig:
    """Assemble the per-request web search config from settings + env.

    SearXNG URL from settings overrides the SEARXNG_URL env var; the Tavily key
    is env-only.
    """
    return WebSearchConfig(
        tavily_api_key=store.tavily_api_key or TAVILY_API_KEY,
        searxng_url=store.searxng_url or SEARXNG_URL_ENV,
        default_mode=store.web_search_mode,  # type: ignore[arg-type]
    )


def build_image_config(store: SettingsStore) -> ImageGenConfig:
    """Assemble the per-request image config from settings.

    The hosted backend deliberately has no key of its own: ``image_api_model``
    is a normal ``<provider>/<model>`` id, so the credentials come from the
    provider the user already configured for chat — and the id goes through the
    same LiteLLM re-tagging as a chat model, or an OpenAI-compatible endpoint
    would fail with "LLM Provider NOT provided".
    """
    model = store.image_api_model.strip()
    api_key: str | None = None
    api_base: str | None = None
    if model:
        provider = store.get_provider(model)
        if provider is not None:
            api_key, api_base = provider.api_key, provider.api_base
        model, api_key = retag_model_for_litellm(provider, model, api_key)

    return ImageGenConfig(
        backend=store.image_backend,  # type: ignore[arg-type]
        api_model=model,
        api_key=api_key,
        api_base=api_base,
        a1111_url=store.a1111_url,
        comfy_url=store.comfy_url,
        comfy_checkpoint=store.comfy_checkpoint,
        comfy_workflow_path=store.comfy_workflow_path,
    )
