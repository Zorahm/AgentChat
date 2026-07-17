"""AskUserTool — agent poses multiple-choice questions, then the turn pauses.

Non-blocking by design. The tool stores no state and returns immediately; the
agent loop ends the turn right after an ``ask_user`` call (see the
``waits_for_input`` flag in ``AgentLoop.run_stream``). The UI renders an
interactive question card. When the user submits, their selections are sent as
a brand-new user message that starts the next turn — there is no server-side
pending state and no answer endpoint.
"""

from __future__ import annotations

from typing import Any

from tools.base import BaseTool, ToolDefinition, ToolSchema


class AskUserTool(BaseTool):
    """Present multiple-choice questions to the user and pause the turn.

    The agent provides a list of questions with options. The UI renders them as
    a tabbed wizard (radio for single, checkbox for multiple). The turn ends
    after this tool runs; the user's answers arrive as their next message.
    """

    name = "ask_user"
    description = (
        "Ask the user one or more questions with predefined options. Each "
        "question carries its own selection_type — 'single' (pick one) or "
        "'multiple' (pick several) — so a single call can mix single- and "
        "multiple-choice questions. The user can also always type their own "
        "free-text answer instead of (or in addition to) the options. Your turn "
        "ENDS after this call — stop and wait. The user's answers arrive as "
        "their next message, which you then act on."
    )

    # The agent loop ends the turn immediately after a tool with this flag runs.
    waits_for_input = True

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "questions": {
                            "type": "array",
                            "description": "List of questions to ask the user.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "question": {
                                        "type": "string",
                                        "description": "The question text.",
                                    },
                                    "options": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "Available answer options.",
                                    },
                                    "selection_type": {
                                        "type": "string",
                                        "enum": ["single", "multiple"],
                                        "description": (
                                            "How many options the user may pick for THIS "
                                            "question: 'single' (radio, pick one) or "
                                            "'multiple' (checkbox, pick several). Defaults "
                                            "to the top-level selection_type, else 'single'. "
                                            "The user can always add a free-text answer too."
                                        ),
                                    },
                                },
                                "required": ["question", "options"],
                            },
                        },
                        "selection_type": {
                            "type": "string",
                            "enum": ["single", "multiple"],
                            "description": (
                                "Default selection_type for questions that don't set their "
                                "own. single = pick one, multiple = pick several. "
                                "Default: single."
                            ),
                        },
                    },
                    "required": ["questions"],
                },
            )
        )

    async def execute(self, **kwargs: Any) -> str:
        questions: list[dict[str, Any]] = kwargs.get("questions", [])
        if not questions:
            return "No questions provided."

        n = len(questions)
        noun = "question" if n == 1 else "questions"
        return (
            f"Posed {n} {noun} to the user. Awaiting their reply — the user's "
            "selections will arrive as their next message. Do not continue or "
            "call further tools until then."
        )
