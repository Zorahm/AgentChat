"""Web-backend resolution and the restricted tool registries a research run uses.

Research resolves its own web backend, independently of the chat's web-search
toggle: a run without web access is pointless, so the toggle must not be able to
disable it.

Every agent gets a *fresh* registry. Tools carry per-run state (sandbox policy,
captured output), and subagents run concurrently — sharing one registry across
them would race exactly the way sharing one across chat requests does.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent.sandbox import SandboxPolicy
from store.settings_store import SettingsStore, build_web_search_config
from tools.read_file import ReadFileTool
from tools.registry import ToolRegistry
from tools.web_fetch_tool import WebFetchTool
from tools.web_search_tool import WebSearchTool
from web_search.config import EffectiveBackend, WebSearchConfig, WebSearchMode
from web_search.service import WebSearchService

NO_BACKEND_MESSAGE = (
    "Research needs web access but no search backend is available. Use a model "
    "with native web search, or configure Tavily (TAVILY_API_KEY) or SearXNG "
    "(SEARXNG_URL / Settings → Providers), then try again."
)


@dataclass(frozen=True, slots=True)
class WebAccess:
    """The web backend a run will use.

    ``native_tool`` is a provider-side tool definition passed to LiteLLM verbatim —
    the provider executes it, so those searches produce no local tool events and
    stay invisible to the timeline. That is a property of native search, not a bug.
    """

    effective: EffectiveBackend
    config: WebSearchConfig
    native_tool: dict[str, Any] | None = None

    @property
    def has_local_search(self) -> bool:
        return self.effective in ("litellm", "searxng")


def resolve_web_access(
    store: SettingsStore,
    service: WebSearchService,
    provider_id: str,
    model: str,
) -> WebAccess | None:
    """Resolve a usable web backend, or ``None`` when there is none."""
    config = build_web_search_config(store)
    resolved = service.resolve(provider_id, model, _mode(store.web_search_mode), config)
    native = resolved.native_tool if resolved.effective == "native" else None
    if resolved.effective == "none" and native is None:
        return None
    return WebAccess(effective=resolved.effective, config=config, native_tool=native)


def build_research_registry(
    access: WebAccess,
    service: WebSearchService,
    policy: SandboxPolicy,
) -> ToolRegistry:
    """The read-only research toolset shared by the lead and every subagent.

    Deliberately without write_file, edit_file or bash: several agents run at
    once against one chat folder, and only the run itself writes the report.
    """
    registry = ToolRegistry()
    registry.register(WebFetchTool())
    if access.has_local_search:
        registry.register(WebSearchTool(service, access.config, access.effective))
    reader = ReadFileTool()
    reader.set_policy(policy)
    registry.register(reader)
    return registry


def _mode(raw: str) -> WebSearchMode:
    """Narrow the stored mode string onto the literal the service expects."""
    if raw == "native":
        return "native"
    if raw == "litellm":
        return "litellm"
    if raw == "searxng":
        return "searxng"
    return "auto"


def native_tools(access: WebAccess) -> list[dict[str, Any]] | None:
    """Provider-side tool definitions to append to a loop's tools array."""
    return [access.native_tool] if access.native_tool else None
