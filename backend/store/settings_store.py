"""Persistent settings store + built-in provider catalogue.

Owns everything settings-related: the default provider list, env-key
resolution, the JSON-backed :class:`SettingsStore`, and the per-request web
search config derived from it. Imports only schemas/services (never the API
route layer), so it sits below the app factory in the dependency graph.
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from pathlib import Path

from api.schemas.settings import (
    ModelConfig,
    ProviderConfig,
    ProviderCreate,
    ProviderUpdate,
    SettingsData,
    SettingsUpdate,
)
from llm.models_fetcher import ModelsFetcher, looks_thinking
from mcp_integration.config import MCPServerConfig, MCPServerUpdate
from paths import SEARXNG_URL_ENV, TAVILY_API_KEY
from web_search.config import WebSearchConfig

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


# ---------------------------------------------------------------------------
# settings store
# ---------------------------------------------------------------------------


SETTINGS_SCHEMA_VERSION = 1


class SettingsStore:
    """Persistent settings store backed by a JSON file.

    Models are not persisted — they're discovered live by ``ModelsFetcher``
    via each provider's ``/models`` endpoint.
    """

    def __init__(
        self,
        fetcher: ModelsFetcher | None = None,
        settings_path: Path | None = None,
    ) -> None:
        self._providers: dict[str, ProviderConfig] = {}
        self._mcp_servers: dict[str, MCPServerConfig] = {}
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
        # Sticky research toggle + the model the inner research loop runs on
        # ("" → fall back to default_model).
        self._research_enabled = False
        self._research_model = ""
        # Long-lived shared secret for remote (phone) access. Generated lazily
        # the first time remote access is enabled; persisted in settings.json.
        self._remote_token = ""
        # Keyboard shortcuts: action id → normalized combo. Empty means the
        # frontend uses its built-in defaults for every action.
        self._shortcuts: dict[str, str] = {}

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

        Missing file is fine (first run). Corrupt file is logged and ignored
        — we'd rather lose user prefs than crash on startup.
        """
        if self._settings_path is None or not self._settings_path.is_file():
            return
        try:
            raw = self._settings_path.read_text("utf-8")
            data = json.loads(raw)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[settings] failed to load {self._settings_path}: {exc}")
            return
        if not isinstance(data, dict):
            return

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
            if isinstance(sp, str) and sp in ("auto", "wsl", "powershell"):
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
            re_ = global_block.get("research_enabled")
            if isinstance(re_, bool):
                self._research_enabled = re_
            rm = global_block.get("research_model")
            if isinstance(rm, str):
                self._research_model = rm
            sc = global_block.get("shortcuts")
            if isinstance(sc, dict):
                self._shortcuts = {
                    str(k): str(v) for k, v in sc.items() if isinstance(v, str)
                }

        providers_block = data.get("providers", [])
        if isinstance(providers_block, list):
            for raw_p in providers_block:
                if not isinstance(raw_p, dict) or "id" not in raw_p:
                    continue
                try:
                    saved = ProviderConfig.model_validate(raw_p)
                except Exception as exc:  # noqa: BLE001
                    print(f"[settings] skipping malformed provider {raw_p!r}: {exc}")
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
                        print(f"[settings] skipping malformed mcp server {raw_s!r}: {exc}")
                        continue
                    self._mcp_servers[server.id] = server

    def _save(self) -> None:
        """Atomically persist current state to settings.json."""
        if self._settings_path is None:
            return
        payload = {
            "version": SETTINGS_SCHEMA_VERSION,
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
                "research_enabled": self._research_enabled,
                "research_model": self._research_model,
                "shortcuts": self._shortcuts,
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
        }
        try:
            self._settings_path.parent.mkdir(parents=True, exist_ok=True)
            # Write to a sibling tmp file then atomic-rename to avoid partial writes.
            fd, tmp_path = tempfile.mkstemp(
                prefix=".settings-", suffix=".json.tmp", dir=self._settings_path.parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(payload, f, indent=2, ensure_ascii=False)
                os.replace(tmp_path, self._settings_path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except OSError as exc:
            print(f"[settings] failed to save {self._settings_path}: {exc}")

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def get(self) -> SettingsData:
        return SettingsData(
            providers=sorted(self._providers.values(), key=lambda p: p.id),
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
            remote_access_enabled=self._remote_access_enabled,
            web_search_mode=self._web_search_mode,
            web_search_enabled=self._web_search_enabled,
            searxng_url=self._searxng_url,
            tavily_api_key_set=bool(self._tavily_api_key or TAVILY_API_KEY),
            research_enabled=self._research_enabled,
            research_model=self._research_model,
            shortcuts=dict(self._shortcuts),
            mcp_servers=sorted(self._mcp_servers.values(), key=lambda s: s.id),
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
            if patch.shell_preference not in ("auto", "wsl", "powershell"):
                raise ValueError(
                    f"shell_preference must be one of auto|wsl|powershell, got {patch.shell_preference!r}"
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
        if patch.research_enabled is not None:
            self._research_enabled = patch.research_enabled
        if patch.research_model is not None:
            self._research_model = patch.research_model.strip()
        if patch.shortcuts is not None:
            # Full replacement; drop blank combos so they fall back to defaults.
            self._shortcuts = {
                str(k): v for k, v in patch.shortcuts.items() if isinstance(v, str) and v
            }
        self._save()
        return self.get()

    def update_provider(self, provider_id: str, patch: ProviderUpdate) -> ProviderConfig:
        if provider_id not in self._providers:
            raise ValueError(f"Unknown provider: {provider_id}")
        p = self._providers[provider_id]
        if patch.api_key is not None:
            p.api_key = patch.api_key if patch.api_key else None
            p.api_key_set = bool(patch.api_key)
        if patch.api_base is not None:
            p.api_base = patch.api_base if patch.api_base else None
        if patch.enabled is not None:
            p.enabled = patch.enabled
        if patch.extra_headers is not None:
            p.extra_headers = dict(patch.extra_headers) or None
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
            existing.config = patch.config
        self._save()
        return existing.model_copy(deep=True)

    def remove_mcp_server(self, server_id: str) -> None:
        if server_id not in self._mcp_servers:
            raise ValueError(f"Unknown MCP server: {server_id}")
        del self._mcp_servers[server_id]
        self._save()

    def upsert_mcp_server(self, cfg: MCPServerConfig) -> None:
        """Insert or replace — used by the bulk import endpoint."""
        self._mcp_servers[cfg.id] = cfg.model_copy(deep=True)
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
    def research_model(self) -> str:
        return self._research_model

    @property
    def tavily_api_key(self) -> str | None:
        return self._tavily_api_key

    @property
    def shell_preference(self) -> str:
        return self._shell_preference

    @property
    def remote_access_enabled(self) -> bool:
        return self._remote_access_enabled

    @property
    def remote_token(self) -> str:
        return self._remote_token


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
