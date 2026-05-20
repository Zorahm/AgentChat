"""FastAPI application entrypoint — Phase 3 + Phase 5.

Usage::

    set OPENAI_API_KEY=sk-...
    uvicorn main:app --host 127.0.0.1 --port 8787
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

# On Windows, asyncio.create_subprocess_exec only works under
# ProactorEventLoop. Uvicorn's default loop selection sometimes hands us a
# SelectorEventLoop, which then raises NotImplementedError() with an empty
# message when we try to spawn wsl.exe — that surfaces as a silent failure
# in the UI ("× ошибка" + empty output). Force the right policy at import
# time so the policy is set before uvicorn builds its loop.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.router import api_router
from api.schemas.settings import (
    ModelConfig,
    ProviderConfig,
    ProviderCreate,
    ProviderUpdate,
    SettingsData,
    SettingsUpdate,
)
from llm.models_fetcher import ModelsFetcher, looks_thinking
from skills.installer import GitHubSkillInstaller
from skills.reader import AgentSkillsReader
from store.chat_store import ChatStore
from tools.bash_tool import BashTool
from tools.read_file import ReadFileTool
from tools.read_skill import ReadSkillTool
from tools.registry import ToolRegistry
from tools.write_file import WriteFileTool

# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

import sys as _sys

if getattr(_sys, "frozen", False):
    # Running as PyInstaller bundle — keep user data in APPDATA, not temp extraction dir
    BASE_DIR = Path(_sys.executable).parent
    AGENTS_DIR = Path(os.environ.get("APPDATA", Path.home())) / "AgentChat" / ".agents"
else:
    BASE_DIR = Path(__file__).resolve().parent
    AGENTS_DIR = BASE_DIR.parent / ".agents"

AGENTS_SKILLS_DIR = AGENTS_DIR / "skills"
SETTINGS_FILE = AGENTS_DIR / "settings.json"
CHAT_DB_FILE = AGENTS_DIR / "agentchat.db"
# Cross-agent shared skills location per the Agent Skills convention:
# ~/.agents/skills/ — read-only from this app's perspective (we don't install or
# delete here, but we DO surface them to the model).
USER_AGENTS_SKILLS_DIR = Path.home() / ".agents" / "skills"

USER_NAME = os.environ.get("USER", os.environ.get("USERNAME", "")) or os.getlogin()
USER_HOME = os.path.expanduser("~")
WSL_USER_HOME = f"/home/{USER_NAME.lower()}" if USER_NAME else "/home/user"

# Tauri bundle identifier — keeps Local AppData/com.zorahm.agentchat off-limits
# to the model alongside the agents settings/db folder.
TAURI_LOCAL_DIR = Path(os.environ.get("LOCALAPPDATA", USER_HOME)) / "com.zorahm.agentchat"


def _wsl_form(win_path: Path) -> str:
    """Translate ``C:\\foo\\bar`` to ``/mnt/c/foo/bar`` for WSL-side comparisons."""
    s = str(win_path)
    if len(s) >= 2 and s[1] == ":":
        drive = s[0].lower()
        rest = s[2:].replace("\\", "/").lstrip("/")
        return f"/mnt/{drive}/{rest}" if rest else f"/mnt/{drive}"
    return s


def get_blocked_read_prefixes() -> tuple[str, ...]:
    """Paths the model is forbidden to read in restricted mode.

    Both Windows and WSL-mount forms are returned so checks work whichever
    path style the model passes in.
    """
    blocks: list[str] = []
    for win in (AGENTS_DIR, TAURI_LOCAL_DIR):
        blocks.append(str(win))
        blocks.append(_wsl_form(win))
    return tuple(blocks)

def build_system_prompt(user_name: str = "") -> str:
    """Build the system prompt with fresh date on every call."""
    name = user_name or os.environ.get("USER", os.environ.get("USERNAME", "")) or os.getlogin()
    now = datetime.now().strftime("%d %B %Y, %H:%M")
    return f"""\
You are an AI assistant running in a desktop application called "AgentChat".

User: {name}
Home (WSL): {WSL_USER_HOME}
Home (Windows): {USER_HOME}
Date: {now}

## Tools

- bash_tool — execute bash commands inside WSL. $USER and $HOME are set. Working directory is the current chat's folder under ~/AgentChat/chats/chat-<id>-<timestamp>/ — files you create with relative paths land there. Use absolute paths only when you explicitly need to write somewhere else.
- read_file — read a file from the local filesystem
- read_skill — read detailed instructions for an installed skill

## Sandbox & uploads

By default this chat runs in a sandbox: bash is confined to the chat folder, write operations are restricted to it, and reads from the app's settings folder are blocked. The user can disable the sandbox in Settings → "Unrestricted mode".

User-attached files (images, documents, archives) are saved into `./uploads/` relative to the chat folder before your turn begins. You have full read/write access to that subfolder — open, inspect, extract, transform, rename, or move them as needed. Treat each attachment's `path:` reference in the user message as the canonical location.

When a task matches a skill description, call read_skill first to get the workflow. Read each skill at most ONCE per conversation — if you have already read it, do not call read_skill again for the same skill. Use what you already know.

**Package installation rules:**
- Install Node packages with `npm install` — NEVER use apt, apt-get, brew, or any system package manager
- Install Python packages with `pip install`
- Assume Node.js, Python, and common runtimes are already available — do not check or install them

## Writing files

**ALWAYS use <file> blocks to create files — NEVER use write_file tool.** The <file> syntax streams content live to the UI while you type.

Format — ONLY the opening and closing tags, nothing else:

<file path="/absolute/path/to/file">
...complete file content, unlimited lines...
</file>

<artifact type="file" path="/absolute/path/to/file" label="Human-readable name" />

Rules:
- Path must be absolute
- Write the COMPLETE file — never truncate, never summarise
- Do NOT add artificial markers inside the file block (no "# OUT", "# EOF", or similar end-of-file markers)
- The file content starts right after the opening tag, ends right before the closing tag
- The UI streams the content live while you type it; there is no length limit
- After </file>, add the <artifact /> tag ONLY for final deliverable files the user will open or use (documents, reports, output files). Do NOT add <artifact /> to intermediate scripts, helper code, or generator files that only exist to produce another file.
- If a file was already written in this conversation, do NOT rewrite it unless the user explicitly asks. Reference it by path instead.

Example:
  Here's the report:

  <file path="/home/user/report.md">
  # Q3 Report

  ## Summary
  Revenue grew by 18%...

  ## Highlights
  - ARR +€2.1M
  </file>

  <artifact type="file" path="/home/user/report.md" label="Q3 Report" />

## Editing existing files

For small in-place changes, use the self-closing <edit /> tag — it replaces ONE occurrence of `old` with `new`:

<edit path="/absolute/path" old="exact text to find" new="replacement text" />

Rules:
- Path must be absolute
- `old` must match EXACTLY ONCE in the file (include surrounding context if needed for uniqueness)
- Attribute values use JSON-style escapes: \\n for newline, \\t for tab, \\" for quote, \\\\ for backslash
- If you need to rewrite the whole file, use <file> instead
- The whole tag must fit on a single logical line (newlines inside values must be escaped as \\n)

Example — fix a typo in a Python file:

  <edit path="/home/user/app.py" old="def proces_data(items):" new="def process_data(items):" />

Example — change a return value (multi-line, using \\n):

  <edit path="/home/user/app.py" old="def get_count():\\n    return 1" new="def get_count():\\n    return 2" />

## Skills
"""

# ---------------------------------------------------------------------------
# default providers
# ---------------------------------------------------------------------------

DEFAULT_PROVIDERS: list[ProviderConfig] = [
    ProviderConfig(id="openai", name="OpenAI", api_base="https://api.openai.com/v1"),
    ProviderConfig(id="anthropic", name="Anthropic", api_base="https://api.anthropic.com"),
    ProviderConfig(id="gemini", name="Google Gemini"),
    ProviderConfig(id="deepseek", name="DeepSeek", api_base="https://api.deepseek.com/v1"),
    ProviderConfig(
        id="openrouter", name="OpenRouter", api_base="https://openrouter.ai/api/v1"
    ),
    ProviderConfig(
        id="opencode",
        name="OpenCode",
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
        self._fetcher = fetcher
        self._settings_path = settings_path
        self._default_model = os.environ.get("AGENT_MODEL", "openai/gpt-4o")
        self._temperature = 0.7
        self._max_iterations = 10
        self._user_name = ""
        self._theme = "system"
        self._onboarding_completed = False
        self._unrestricted_mode = False

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
            ob = global_block.get("onboarding_completed")
            if isinstance(ob, bool):
                self._onboarding_completed = ob
            ur = global_block.get("unrestricted_mode")
            if isinstance(ur, bool):
                self._unrestricted_mode = ur

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
                "onboarding_completed": self._onboarding_completed,
                "unrestricted_mode": self._unrestricted_mode,
            },
            "providers": [
                p.model_dump() for p in sorted(self._providers.values(), key=lambda x: x.id)
            ],
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
            onboarding_completed=self._onboarding_completed,
            unrestricted_mode=self._unrestricted_mode,
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
        if patch.onboarding_completed is not None:
            self._onboarding_completed = patch.onboarding_completed
        if patch.unrestricted_mode is not None:
            self._unrestricted_mode = patch.unrestricted_mode
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


# ---------------------------------------------------------------------------
# app factory
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    """Build the FastAPI application with all routers and state."""

    AGENTS_SKILLS_DIR.mkdir(parents=True, exist_ok=True)

    # --- stateful singletons ---
    # Reader scans the app's local dir first (skills installed via our UI), then
    # the user-global ~/.agents/skills/ (shared with other agent systems). On a
    # name collision the local one wins, which mirrors how shells resolve PATH.
    reader = AgentSkillsReader([AGENTS_SKILLS_DIR, USER_AGENTS_SKILLS_DIR])
    reader.rebuild()

    installer = GitHubSkillInstaller(AGENTS_SKILLS_DIR, reader)
    models_fetcher = ModelsFetcher()
    settings_store = SettingsStore(fetcher=models_fetcher, settings_path=SETTINGS_FILE)
    chat_store = ChatStore(CHAT_DB_FILE)

    # --- tools ---
    registry = ToolRegistry()
    registry.register(BashTool(user_name=USER_NAME, user_home=WSL_USER_HOME))
    registry.register(ReadFileTool())
    registry.register(WriteFileTool())
    registry.register(ReadSkillTool(reader))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> Any:
        yield

    app = FastAPI(
        title="AgentChat",
        version="0.2.0",
        lifespan=lifespan,
    )

    # --- CORS (allow Vite dev server + Tauri webview) ---
    # Tauri v2 on Windows serves the webview from http://tauri.localhost (HTTP).
    # macOS/Linux use https://tauri.localhost or the tauri:// custom scheme.
    # If the production scheme is missing here, fetch() in the installed app
    # is blocked by the browser and the UI hangs on "Загрузка…" forever.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        allow_origin_regex=r"^(tauri|https?)://(.*\.)?tauri\.localhost$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # --- attach state for route handlers ---
    app.state.skill_reader = reader
    app.state.skill_installer = installer
    app.state.settings_store = settings_store
    app.state.chat_store = chat_store
    app.state.models_fetcher = models_fetcher
    app.state.tool_registry = registry
    app.state.system_prompt_factory: Callable[[], str] = lambda: build_system_prompt(
        user_name=settings_store.user_name,
    )

    # --- routers ---
    app.include_router(api_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
