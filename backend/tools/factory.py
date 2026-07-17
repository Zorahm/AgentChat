"""Tool registry factory.

Kept separate from ``main`` (the app factory) and from any single tool so both
startup and every ``/api/chat`` request can build a fresh tool set without an
import cycle.
"""

from __future__ import annotations

from paths import DEFAULT_BASH_HOME, USER_NAME
from skills.reader import AgentSkillsReader
from tools.ask_user import AskUserTool
from tools.bash_tool import BashTool
from tools.edit_file import EditFileTool
from tools.present_files import PresentFilesTool
from tools.read_file import ReadFileTool
from tools.read_photo import ReadPhotoTool
from tools.read_skill import ReadSkillTool
from tools.registry import ToolRegistry
from tools.show_widget import ShowWidgetTool
from tools.web_fetch_tool import WebFetchTool
from tools.write_file import WriteFileTool


def build_tool_registry(reader: AgentSkillsReader) -> ToolRegistry:
    """Build a registry with a fresh set of tool instances.

    Called once at startup and **again per /api/chat request**. A fresh set
    matters because each request stamps its sandbox policy onto the
    filesystem tools via ``set_policy``; sharing one set across concurrent
    chats (now possible — a chat keeps streaming when you open another) would
    let one chat's policy clobber another's and cross sandbox boundaries.
    The skills *reader* is shared by design — it is read-only at execution time.
    """
    registry = ToolRegistry()
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
    return registry
