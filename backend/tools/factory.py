"""Tool registry factory.

Kept separate from ``main`` (the app factory) and from any single tool so both
startup and every ``/api/chat`` request can build a fresh tool set without an
import cycle.
"""

from __future__ import annotations

from mathkit.runner import MathWorkerPool
from paths import DEFAULT_BASH_HOME, USER_NAME
from schemas.agents import ToolPolicy
from skills.reader import AgentSkillsReader
from store.memory_store import MemoryStore
from tools.ask_user import AskUserTool
from tools.bash_tool import BashTool
from tools.edit_file import EditFileTool
from tools.grep_tool import GrepTool
from tools.list_dir import ListDirTool
from tools.math_eval import MathEvalTool
from tools.math_plot import MathPlotTool
from tools.math_verify import MathVerifyTool
from tools.memory_tools import build_memory_tools
from tools.present_files import PresentFilesTool
from tools.read_file import ReadFileTool
from tools.read_photo import ReadPhotoTool
from tools.read_skill import ReadSkillTool
from tools.registry import ToolRegistry
from tools.show_widget import ShowWidgetTool
from tools.web_fetch_tool import WebFetchTool
from tools.write_file import WriteFileTool

# Named here rather than derived from the tool classes so a test can assert the
# exact roster a `memory_only` agent ships without importing the tools.
MEMORY_TOOL_NAMES: tuple[str, ...] = ("remember", "recall", "forget")

# The maths trio. `math_verify` in particular is a *base* tool, not a preset one:
# a machine-checked answer is worth having in any chat that produces a final
# number, and gating it behind a mode would mean the guarantee only exists where
# someone remembered to switch it on. What the maths preset changes is how often
# the skill tells the model to reach for it, not whether it can.
MATH_TOOL_NAMES: tuple[str, ...] = ("math_eval", "math_verify", "math_plot")


def build_tool_registry(
    reader: AgentSkillsReader,
    *,
    tool_policy: ToolPolicy = "full",
    allowed_tools: list[str] | None = None,
    memory_store: MemoryStore | None = None,
    agent_id: str = "",
    chat_id: str = "",
    math_pool: MathWorkerPool | None = None,
) -> ToolRegistry:
    """Build a registry with a fresh set of tool instances.

    Called once at startup and **again per /api/chat request**. A fresh set
    matters because each request stamps its sandbox policy onto the
    filesystem tools via ``set_policy``; sharing one set across concurrent
    chats (now possible — a chat keeps streaming when you open another) would
    let one chat's policy clobber another's and cross sandbox boundaries.
    The skills *reader* is shared by design — it is read-only at execution time.

    ``tool_policy`` is the agent's. ``memory_only`` is what lets a roleplay
    character keep a memory without also being handed a shell — note the
    overlays applied later in ``api.chat`` (MCP proxies, web search, research)
    are gated on the same policy there, since they are not built here.

    A missing ``memory_store`` is how ``memory_enabled=False`` arrives; the
    factory stays free of agent-record semantics.

    ``allowed_tools`` is the agent's whitelist, applied last. Empty means no
    restriction — the shape every agent written before the field existed loads
    with. It is applied by *removing* rather than by skipping registration so
    one rule covers the memory tools too, and so a name that no longer exists
    silently narrows nothing instead of raising.

    ``math_pool`` is the shared worker pool. Shared deliberately, unlike
    everything else here: it is a set of warm processes, and one per request
    would pay sympy's import cost on every single call.
    """
    registry = ToolRegistry()

    if tool_policy == "none":
        return registry

    if tool_policy == "full":
        registry.register(BashTool(user_name=USER_NAME, user_home=DEFAULT_BASH_HOME))
        registry.register(ReadFileTool())
        registry.register(ListDirTool())
        registry.register(GrepTool(user_name=USER_NAME, user_home=DEFAULT_BASH_HOME))
        registry.register(ReadPhotoTool())
        registry.register(WriteFileTool())
        registry.register(EditFileTool())
        registry.register(PresentFilesTool())
        registry.register(ShowWidgetTool())
        registry.register(ReadSkillTool(reader))
        registry.register(WebFetchTool())
        registry.register(AskUserTool())
        if math_pool is not None:
            registry.register(MathEvalTool(math_pool))
            registry.register(MathVerifyTool(math_pool))
            registry.register(MathPlotTool(math_pool))

    if memory_store is not None:
        for tool in build_memory_tools(memory_store, agent_id=agent_id, chat_id=chat_id):
            registry.register(tool)

    apply_whitelist(registry, allowed_tools)
    return registry


def apply_whitelist(registry: ToolRegistry, allowed_tools: list[str] | None) -> None:
    """Drop every registered tool the agent's whitelist doesn't name.

    A no-op for an empty or missing list, which is what "unrestricted" means
    here. Shared with ``api.chat`` so the overlays it builds — MCP proxies, web
    search, research, image generation — obey the same list; a whitelist that
    only covered the built-ins would leave a "maths only" agent holding the web.
    """
    if not allowed_tools:
        return
    permitted = {name.strip() for name in allowed_tools if name and name.strip()}
    if not permitted:
        return
    for name in list(registry.list_names()):
        if name not in permitted:
            registry.unregister(name)
