"""The one tool a subagent has beyond searching and reading: handing work back.

A structured hand-off rather than harvesting the loop's last assistant message.
Harvesting cannot tell a finished answer from mid-thought chatter, so any polite
"here's what I found:" preamble — or an iteration cap hit at the wrong moment —
used to end up being treated as the result.
"""

from __future__ import annotations

from typing import Any

from tools.base import BaseTool, ToolDefinition, ToolSchema


class SubmitFindingsTool(BaseTool):
    """Captures one subagent's result. One instance per subagent."""

    name = "submit_findings"
    description = (
        "Hand your findings to the lead researcher and finish your task. This is "
        "the only channel the lead reads, so put everything you learned here — "
        "what you found, the sources it came from, and what you could not resolve."
    )

    def __init__(self) -> None:
        self.submitted = False
        self.summary = ""
        self.sources: list[str] = []
        self.gaps = ""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": (
                                "What you found, in the language of your task. Be "
                                "specific: figures, dates, names and direct quotes "
                                "are what the lead can actually use. Attribute each "
                                "claim to the source it came from."
                            ),
                        },
                        "sources": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "URLs (or local file paths) you actually opened and "
                                "relied on. Do not list results you never read."
                            ),
                        },
                        "gaps": {
                            "type": "string",
                            "description": (
                                "What your task asked for that you could not "
                                "establish, and why. Empty if nothing is missing."
                            ),
                        },
                    },
                    "required": ["summary"],
                },
            )
        )

    async def execute(
        self,
        summary: str = "",
        sources: Any = None,
        gaps: str = "",
        **_: Any,
    ) -> str:
        self.summary = (summary or "").strip()
        self.gaps = (gaps or "").strip()
        if isinstance(sources, list):
            self.sources = [str(s).strip() for s in sources if str(s).strip()]
        elif isinstance(sources, str) and sources.strip():
            self.sources = [sources.strip()]
        self.submitted = True
        if not self.summary:
            return "Error: submit_findings needs a non-empty 'summary'."
        return "Findings delivered to the lead researcher. Your task is complete."
