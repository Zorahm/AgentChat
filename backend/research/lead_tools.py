"""The lead researcher's control tools: publish a plan, narrate, submit the report.

All three exist so the run's structure comes from explicit model decisions instead
of being inferred from prose. The plan used to be scraped out of the model's first
tokens with a regex, and the report used to be whatever the last assistant message
happened to contain; both broke the moment the model phrased things differently.
"""

from __future__ import annotations

from typing import Any

from research.progress import ProgressEmitter
from research.types import PlanStep
from tools.base import BaseTool, ToolDefinition, ToolSchema

_MAX_PLAN_STEPS = 12


class PlanResearchTool(BaseTool):
    """Publishes the lead's plan to the user's live timeline."""

    name = "plan_research"
    description = (
        "Publish the sub-questions you intend to answer. Call this once, before "
        "delegating. The user watches this list while the run happens, so write "
        "the titles for a reader, in the language the report will be written in."
    )

    def __init__(self, emitter: ProgressEmitter) -> None:
        self._emitter = emitter
        self.steps: list[PlanStep] = []

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "The sub-questions, one short readable line each, "
                                "in the order you mean to tackle them."
                            ),
                        }
                    },
                    "required": ["steps"],
                },
            )
        )

    async def execute(self, steps: Any = None, **_: Any) -> str:
        titles = _as_titles(steps)
        if not titles:
            return "Error: plan_research needs a non-empty 'steps' list."
        self.steps = [
            PlanStep(id=f"s{i}", title=title) for i, title in enumerate(titles[:_MAX_PLAN_STEPS], 1)
        ]
        self._emitter.plan([{"id": s.id, "title": s.title} for s in self.steps])
        return f"Plan published ({len(self.steps)} steps). Now delegate the ones worth delegating."


class NoteTool(BaseTool):
    """Free-form status line from the lead to the user."""

    name = "note"
    description = (
        "Tell the user in one short line what you are doing or what you just "
        "realized — in the language of the report. Use it whenever your next move "
        "would not be obvious from the plan. It costs nothing and ends nothing."
    )

    def __init__(self, emitter: ProgressEmitter) -> None:
        self._emitter = emitter

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "One short line for the user."}
                    },
                    "required": ["text"],
                },
            )
        )

    async def execute(self, text: str = "", **_: Any) -> str:
        self._emitter.note(text)
        return "Noted."


class SubmitReportTool(BaseTool):
    """Captures the finished report. Calling it ends the run."""

    name = "submit_report"
    description = (
        "Submit the finished report and end the research run. The markdown you "
        "pass is saved verbatim and shown to the user — write it the way the brief "
        "asks, and put nothing else in it."
    )

    def __init__(self) -> None:
        self.submitted = False
        self.title = ""
        self.markdown = ""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": (
                                "Short title of the report, in its language. Shown "
                                "on the research card and used for the file name."
                            ),
                        },
                        "markdown": {
                            "type": "string",
                            "description": (
                                "The complete report in markdown. No preamble, no "
                                "'here is the report' — just the report."
                            ),
                        },
                    },
                    "required": ["title", "markdown"],
                },
            )
        )

    async def execute(self, title: str = "", markdown: str = "", **_: Any) -> str:
        self.markdown = (markdown or "").strip()
        self.title = (title or "").strip()
        if not self.markdown:
            return "Error: submit_report needs a non-empty 'markdown' report."
        self.submitted = True
        return f"Report received ({len(self.markdown)} chars). The run is complete."


def _as_titles(steps: Any) -> list[str]:
    """Accept a list of strings or of ``{title|question|step}`` objects."""
    if isinstance(steps, str):
        steps = [steps]
    if not isinstance(steps, list):
        return []
    titles: list[str] = []
    for item in steps:
        if isinstance(item, str):
            text = item
        elif isinstance(item, dict):
            raw = item.get("title") or item.get("question") or item.get("step") or ""
            text = str(raw)
        else:
            text = str(item)
        cleaned = text.strip()
        if cleaned:
            titles.append(cleaned[:200])
    return titles
