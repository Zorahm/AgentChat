"""show_widget tool — render an inline interactive visualization in the chat.

The model writes ordinary, self-contained HTML/SVG (optionally pulling a charting
library such as Chart.js, D3 or Plotly from a CDN, or drawing on a ``<canvas>``)
and the UI renders it inline as a themed widget card. The host wraps the markup in
a full document and injects design-token CSS variables, so the widget matches the
app's theme and follows light/dark.

This tool is *stateless*: it touches no filesystem and needs no sandbox policy.
The widget HTML travels in the tool call's ``html`` argument — the UI reads it from
there (it is persisted with the chat, so the widget re-renders on reload). This
method just validates the input and returns a short confirmation; it never echoes
the HTML back, keeping the model's context lean.
"""

from __future__ import annotations

from tools.base import BaseTool, ToolDefinition, ToolSchema

# Soft ceiling — past this the widget is almost certainly a mistake (a whole file
# pasted in, runaway generation). We still render it but warn the model. Generous,
# because rich UI mockups and inline-data charts are legitimately large.
_MAX_HTML_BYTES = 4 * 1024 * 1024


class ShowWidgetTool(BaseTool):
    """Render self-contained HTML inline in the chat as a themed widget."""

    name = "show_widget"
    description = (
        "Render self-contained HTML inline in the chat as a themed widget — data "
        "visualizations (charts, plots), diagrams, rich tables, or UI mockups "
        "(laying out buttons, cards, form controls, component designs). Pass `html`: "
        "markup plus any <style>/<script>. Use plain HTML/CSS, <canvas>/SVG, or load "
        "Chart.js / D3 / Plotly from a CDN via <script src>. The host wraps your markup "
        "in a full document and injects theme CSS variables (--bg, --fg, --muted, "
        "--accent, --border, --chart-1…--chart-8, --grid, --axis, --font-sans, "
        "--font-mono) — reference those instead of hardcoding colors so the widget "
        "matches light/dark. The card sizes to your content (height unconstrained), so "
        "lay it out yourself. Use this when something is better shown than described — "
        "otherwise answer in normal text."
    )

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "html": {
                            "type": "string",
                            "description": (
                                "The widget body: self-contained HTML/SVG plus any "
                                "<style>/<script>. No <html>/<head>/<body> wrapper "
                                "needed — the host adds it and injects theme variables."
                            ),
                        },
                        "title": {
                            "type": "string",
                            "description": "Short label shown on the widget card header.",
                        },
                    },
                    "required": ["html"],
                },
            )
        )

    async def execute(self, html: str = "", title: str = "") -> str:
        """Validate the markup and confirm the widget was rendered to the user."""
        if not isinstance(html, str) or not html.strip():
            return "Error: show_widget needs a non-empty 'html' string."

        label = title.strip() or "visualization"
        size = len(html.encode("utf-8"))
        if size > _MAX_HTML_BYTES:
            return (
                f'Rendered the "{label}" widget, but its HTML is large '
                f"({size // 1024} KB) — consider trimming inline data or loading it "
                "from a CDN so the chat stays responsive."
            )
        return f'Rendered the "{label}" widget for the user.'
