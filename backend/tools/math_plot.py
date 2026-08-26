"""math_plot — describe the picture, don't draw it.

Handed ``show_widget`` and asked for a graph, a model writes 150 lines of chart
setup, differently every time, and the result needs a CDN to be reachable when
the card renders. Here the model names a plot kind, the expressions and the
window; the backend samples with SymPy and emits one inline SVG built from the
app's theme tokens. Offline-safe, identical twice, exportable as a single file.

``show_widget`` stays for everything this cannot express: a geometric
construction, an animated convergence, an interactive ε–δ illustration.
"""

from __future__ import annotations

import asyncio
from typing import Any

from mathkit.progress import PlotProgressEmitter
from mathkit.runner import MathWorkerError, MathWorkerPool
from tools.base import BaseTool, ToolDefinition, ToolSchema

_KINDS = ("cartesian", "parametric", "polar", "implicit", "field", "surface", "discrete")

# Generous: an SVG this large means a pathological sampling case, not a picture
# anyone can read, and it would bloat the saved chat tree for nothing.
_MAX_SVG_BYTES = 3 * 1024 * 1024


class MathPlotTool(BaseTool):
    """Render a mathematical plot as a themed, self-contained SVG."""

    name = "math_plot"
    description = (
        "Draw a mathematical plot — the backend samples the expressions and renders "
        "a themed SVG inline in the chat. Pick `kind`: cartesian (y=f(x)), "
        "parametric (x(t),y(t) in pairs), polar (r(θ)), implicit (F(x,y)=0), field "
        "(a 2-D vector field from two components), surface (z=f(x,y) as an "
        "isometric wireframe) or discrete (a sequence over integer n). Give the "
        "expressions in SymPy notation and the window in `ranges`. Use this instead "
        "of describing a graph in words, and instead of hand-writing chart HTML. "
        "For a geometric construction or an animation, use show_widget instead."
    )
    # Signals agent.loop to run execute() as a task and forward progress_queue
    # events as tool_progress while it runs — the SVG only exists after the call.
    streams_progress = True

    def __init__(self, pool: MathWorkerPool) -> None:
        self._pool = pool
        self.progress_queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": list(_KINDS),
                            "description": "Which kind of plot to draw.",
                        },
                        "exprs": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "Expressions in SymPy notation. One per curve for "
                                "cartesian/polar/implicit/discrete; PAIRS of x(t),y(t) for "
                                "parametric; exactly two components for field; one for surface."
                            ),
                        },
                        "ranges": {
                            "type": "object",
                            "description": (
                                'The window, as {"x": [-5, 5], "y": [-2, 2]}. Use "t" for '
                                'parametric, "theta" for polar, "n" for discrete. Omit "y" '
                                "on a cartesian plot to have it fitted to the data."
                            ),
                        },
                        "annotations": {
                            "type": "array",
                            "items": {"type": "object"},
                            "description": (
                                'Marks on the plot: {"kind":"point","x":..,"y":..,"label":".."}, '
                                '{"kind":"vline","x":..,"label":"asymptote"}, {"kind":"hline","y":..}, '
                                '{"kind":"area","series":0,"from":a,"to":b} to shade under a curve, '
                                '{"kind":"tangent","series":0,"at":x0} to draw a tangent line, '
                                '{"kind":"label","x":..,"y":..,"text":".."}.'
                            ),
                        },
                        "labels": {
                            "type": "object",
                            "description": (
                                'Titles and axis names: {"title": "...", "x": "...", "y": "...", '
                                '"series": ["f(x)", "g(x)"]}.'
                            ),
                        },
                    },
                    "required": ["kind", "exprs"],
                },
            )
        )

    async def execute(  # type: ignore[override]
        self,
        kind: str = "cartesian",
        exprs: list[str] | str | None = None,
        ranges: dict[str, Any] | None = None,
        annotations: list[dict[str, Any]] | None = None,
        labels: dict[str, Any] | None = None,
    ) -> str:
        emit = PlotProgressEmitter(self.progress_queue)
        try:
            return await self._run(emit, kind, exprs, ranges, annotations, labels)
        except Exception as exc:  # noqa: BLE001 — a tool must never break the turn
            # The type is named because some exceptions carry no message at all:
            # `NotImplementedError()` stringifies to "", and for a while every
            # failure here read "Error: math_plot failed — " with nothing after
            # the dash, which is indistinguishable from a bug in the formatting.
            detail = f"{type(exc).__name__}: {exc}".rstrip(": ")
            emit.failed(detail)
            return f"Error: math_plot failed — {detail}"
        finally:
            emit.done()

    async def _run(
        self,
        emit: PlotProgressEmitter,
        kind: str,
        exprs: list[str] | str | None,
        ranges: dict[str, Any] | None,
        annotations: list[dict[str, Any]] | None,
        labels: dict[str, Any] | None,
    ) -> str:
        expressions = [exprs] if isinstance(exprs, str) else list(exprs or [])
        expressions = [str(e).strip() for e in expressions if str(e).strip()]
        if not expressions:
            return "Error: math_plot needs at least one expression in 'exprs'."
        if kind not in _KINDS:
            return f"Error: unknown plot kind {kind!r}. Expected one of: {', '.join(_KINDS)}."

        title = str((labels or {}).get("title") or "")
        emit.start(kind, expressions, title)

        try:
            result = await self._pool.submit(
                "plot",
                {
                    "kind": kind,
                    "exprs": expressions,
                    "ranges": ranges if isinstance(ranges, dict) else {},
                    "annotations": [a for a in (annotations or []) if isinstance(a, dict)],
                    "labels": labels if isinstance(labels, dict) else {},
                },
            )
        except MathWorkerError as exc:
            emit.failed(str(exc))
            return f"Error: {exc}"

        error = result.get("error")
        if error:
            emit.failed(str(error))
            return f"Error: {error}"

        svg = str(result.get("svg") or "")
        if len(svg.encode("utf-8")) > _MAX_SVG_BYTES:
            emit.failed("the rendered plot is too large")
            return (
                "Error: the rendered plot came out unreasonably large — narrow the "
                "range or reduce the number of expressions."
            )

        warnings = [str(w) for w in (result.get("warnings") or [])]
        emit.svg(svg, title=str(result.get("title") or title), warnings=warnings)

        summary = (
            f"Rendered a {kind} plot of {', '.join(expressions[:4])}"
            f"{' …' if len(expressions) > 4 else ''}. The user can see it."
        )
        if warnings:
            summary += "\n" + "\n".join(f"Note: {w}" for w in warnings)
        summary += (
            "\nIt appears in your reply as its own card, at the point where you "
            "called this tool — so text you write after this call reads as being "
            "below the picture. Do NOT write a markdown image link, an ![](...) "
            "tag, or 'see the figure below/above' scaffolding: there is no file to "
            "link to, the link renders as a broken image, and you cannot know "
            "which side of the card a sentence will land on. Just say what the "
            "picture shows that matters to the problem."
        )
        return summary
