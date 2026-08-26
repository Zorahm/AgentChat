"""The plotting entry point: one payload in, one SVG out.

Tangent lines are resolved here rather than in the renderer, because a tangent
is mathematics (differentiate, evaluate at a point) and the renderer only knows
geometry. Everything else the model asks for is passed through to the sampler
that owns that plot kind.
"""

from __future__ import annotations

from typing import Any

import sympy

from mathkit.parsing import parse_math, parse_symbol
from mathkit.plot.sampler import SAMPLERS, PlotData, Series
from mathkit.plot.svg import render_svg

MAX_EXPRESSIONS = 8


def render_plot(payload: dict[str, Any]) -> dict[str, Any]:
    """Sample, annotate and render. Never raises — the caller is a worker loop."""
    kind = str(payload.get("kind") or "cartesian").lower()
    sampler = SAMPLERS.get(kind)
    if sampler is None:
        return {
            "error": f"unknown plot kind {kind!r} — expected one of {', '.join(sorted(SAMPLERS))}"
        }

    exprs = [str(e) for e in (payload.get("exprs") or []) if str(e).strip()]
    if not exprs:
        return {"error": "math_plot needs at least one expression in `exprs`"}
    if len(exprs) > MAX_EXPRESSIONS:
        return {"error": f"at most {MAX_EXPRESSIONS} expressions per plot"}

    ranges = payload.get("ranges") if isinstance(payload.get("ranges"), dict) else {}
    labels = payload.get("labels") if isinstance(payload.get("labels"), dict) else {}
    annotations = [a for a in (payload.get("annotations") or []) if isinstance(a, dict)]

    series_labels = [str(s) for s in (labels.get("series") or [])]
    try:
        data = sampler(exprs, ranges, series_labels)
    except Exception as exc:  # noqa: BLE001 — a sampler failure is a plot failure
        return {"error": f"could not sample the expression: {type(exc).__name__}: {exc}"[:400]}

    _apply_labels(data, labels, kind)
    warnings = _add_tangents(data, annotations, exprs, kind)

    if not any(s.paths or s.points or s.vectors for s in data.series):
        return {
            "error": (
                "nothing was drawable — the expression has no finite values in the "
                "requested range. Check the range, or the variable name."
            )
        }

    return {
        "svg": render_svg(data, annotations),
        "title": data.title,
        "kind": kind,
        "series": len(data.series),
        "warnings": warnings,
    }


def _apply_labels(data: PlotData, labels: dict[str, Any], kind: str) -> None:
    """Caller labels win; otherwise keep the sampler's own (already-set) defaults."""
    data.title = str(labels.get("title") or data.title)
    if labels.get("x"):
        data.x_label = str(labels["x"])
    if labels.get("y"):
        data.y_label = str(labels["y"])
    if kind == "polar" and not labels.get("x"):
        data.x_label, data.y_label = "x", "y"


def _add_tangents(
    data: PlotData, annotations: list[dict[str, Any]], exprs: list[str], kind: str
) -> list[str]:
    """Turn each ``{"kind": "tangent", "at": x0}`` into a real line series.

    Consumed here — the annotation is removed from the list so the renderer
    never sees a kind it has no drawing rule for.
    """
    warnings: list[str] = []
    tangents = [a for a in annotations if str(a.get("kind") or "").lower() == "tangent"]
    if not tangents:
        return warnings
    if kind != "cartesian":
        annotations[:] = [a for a in annotations if a not in tangents]
        return ["tangent annotations are only supported on cartesian plots"]

    variable = parse_symbol("x")
    for item in tangents:
        annotations.remove(item)
        index = int(item.get("series", item.get("expr_index", 0)) or 0)
        if not 0 <= index < len(exprs):
            warnings.append(f"tangent refers to expression {index}, which does not exist")
            continue
        try:
            expr = parse_math(exprs[index], what="the expression")
            point = float(sympy.N(parse_math(str(item.get("at", item.get("x", 0))), what="the tangent point")))
            slope = float(sympy.N(sympy.diff(expr, variable).subs(variable, point)))
            height = float(sympy.N(expr.subs(variable, point)))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"could not build the tangent: {type(exc).__name__}")
            continue

        x_low, x_high = data.x_range
        line = [(x, height + slope * (x - point)) for x in (x_low, x_high)]
        data.series.append(
            Series(
                label=str(item.get("label") or f"tangent at x={point:g}"),
                style="line",
                paths=[line],
            )
        )
        annotations.append({"kind": "point", "x": point, "y": height})
    return warnings
