"""Tool registry factory.

Kept separate from ``main`` (the app factory) and from any single tool so both
startup and every ``/api/chat`` request can build a fresh tool set without an
import cycle.
"""

from __future__ import annotations

from paths import DEFAULT_BASH_HOME, USER_NAME
from schemas.agents import ToolPolicy
from skills.reader import AgentSkillsReader
from store.memory_store import MemoryStore
from tools.ask_user import AskUserTool
from tools.bash_tool import BashTool
from tools.edit_file import EditFileTool
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


def build_tool_registry(
    reader: AgentSkillsReader,
    *,
    tool_policy: ToolPolicy = "full",
    memory_store: MemoryStore | None = None,
    agent_id: str = "",
    chat_id: str = "",
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
    """
    registry = ToolRegistry()

    if tool_policy == "none":
        return registry

    if tool_policy == "full":
        registry.register(BashTool(user_name=USER_NAME, user_home=DEFAULT_BASH_HOME))
        registry.register(ReadFileTool())
        registry.register(ReadPhotoTool())
        registry.register(WriteFileTool())
        registry.register(EditFileTool())
        registry.register(PresentFilesTool())
        registry.register(ShowWidgetTool())
        registry.register(ReadSkillTool(reader))
        registry.register(WebFetchTool())
        registry.register(AskUserTool())

    if memory_store is not None:
        for tool in build_memory_tools(memory_store, agent_id=agent_id, chat_id=chat_id):
            registry.register(tool)

    return registry
