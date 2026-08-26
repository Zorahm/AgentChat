"""Turn expressions into polylines, points and arrows in data coordinates.

The one non-obvious job here is **breaking curves at poles**. Sampling ``tan(x)``
or ``1/x`` naively produces a single polyline containing a near-vertical segment
that races from +∞ to −∞ across the plot — the classic false asymptote, drawn by
every plotting library that treats the samples as one connected path. Every
sampler below splits a series whenever the value stops being finite or jumps by
more than a plot-height between adjacent points.
"""

from __future__ import annotations

import cmath
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

import sympy

from mathkit.parsing import free_symbols_of, parse_math, parse_symbol

# Enough that a smooth curve reads as smooth at any reasonable card width,
# cheap enough that a dozen series still render in well under a second.
SAMPLES = 600
GRID_STEPS = 24
FIELD_STEPS = 18
SURFACE_STEPS = 26

Point = tuple[float, float]


@dataclass(frozen=True)
class Series:
    """One drawable thing, already in data coordinates."""

    label: str
    style: str  # line | scatter | stem | vector
    paths: list[list[Point]] = field(default_factory=list)
    points: list[Point] = field(default_factory=list)
    vectors: list[tuple[float, float, float, float]] = field(default_factory=list)


@dataclass
class PlotData:
    """Everything the renderer needs, with nothing left to compute."""

    series: list[Series] = field(default_factory=list)
    x_range: tuple[float, float] = (-5.0, 5.0)
    y_range: tuple[float, float] = (-5.0, 5.0)
    x_label: str = "x"
    y_label: str = "y"
    title: str = ""
    notes: list[str] = field(default_factory=list)
    # True where the picture's *shape* is the content: a circle has to come out
    # round, a cardioid heart-shaped, a rotation field square. The renderer then
    # gives one x unit and one y unit the same number of pixels. Left False for
    # y = f(x), where the axes measure unrelated quantities and forcing them to
    # a common scale would squash the curve into a line.
    equal_aspect: bool = False


def _range(ranges: dict[str, Any] | None, name: str, default: tuple[float, float]) -> tuple[float, float]:
    spec = (ranges or {}).get(name)
    if isinstance(spec, (list, tuple)) and len(spec) >= 2:
        try:
            low, high = float(spec[0]), float(spec[1])
        except (TypeError, ValueError):
            return default
        if low < high:
            return low, high
    return default


def _compile(expr: sympy.Expr, symbols: Sequence[sympy.Symbol]) -> Callable[..., Any]:
    try:
        return sympy.lambdify(list(symbols), expr, modules=["math", "mpmath"])
    except Exception:  # noqa: BLE001

        def fallback(*args: Any) -> Any:
            return complex(sympy.N(expr.subs(dict(zip(symbols, args))), 15))

        return fallback


def _real(value: Any) -> float | None:
    """Coerce to a finite real, or ``None`` — which is how a break is signalled."""
    try:
        out = complex(value)
    except (TypeError, ValueError, OverflowError, ZeroDivisionError):
        return None
    if abs(out.imag) > 1e-9 or not cmath.isfinite(out):
        return None
    return out.real


def _split_paths(raw: list[tuple[float, float | None]], y_span: float) -> list[list[Point]]:
    """Group consecutive finite samples, breaking at gaps and at pole jumps."""
    paths: list[list[Point]] = []
    current: list[Point] = []
    previous: float | None = None
    # A jump larger than the visible height cannot be a real segment of a
    # continuous function at this sampling density — it is a pole crossing.
    threshold = max(y_span, 1e-9) * 1.5

    for x, y in raw:
        if y is None:
            if len(current) > 1:
                paths.append(current)
            current, previous = [], None
            continue
        if previous is not None and abs(y - previous) > threshold:
            if len(current) > 1:
                paths.append(current)
            current = []
        current.append((x, y))
        previous = y

    if len(current) > 1:
        paths.append(current)
    return paths


def sample_cartesian(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """``y = f(x)`` for each expression, over a shared x window."""
    x_low, x_high = _range(ranges, "x", (-5.0, 5.0))
    variable = parse_symbol((ranges or {}).get("variable", "x") if ranges else "x", default="x")

    parsed = [parse_math(text, what="the expression") for text in exprs]
    y_low, y_high = _range(ranges, "y", (0.0, 0.0))
    auto_y = y_low >= y_high

    raw_series: list[list[tuple[float, float | None]]] = []
    seen: list[float] = []
    for expr in parsed:
        fn = _compile(expr, [variable])
        samples: list[tuple[float, float | None]] = []
        for index in range(SAMPLES + 1):
            x = x_low + (x_high - x_low) * index / SAMPLES
            try:
                y = _real(fn(x))
            except Exception:  # noqa: BLE001 — a pole is a break, not a failure
                y = None
            samples.append((x, y))
            if y is not None:
                seen.append(y)
        raw_series.append(samples)

    if auto_y:
        y_low, y_high = _auto_window(seen)

    return PlotData(
        series=[
            Series(
                label=labels[i] if i < len(labels) else str(parsed[i]),
                style="line",
                paths=_split_paths(raw, y_high - y_low),
            )
            for i, raw in enumerate(raw_series)
        ],
        x_range=(x_low, x_high),
        y_range=(y_low, y_high),
    )


def _auto_window(values: list[float]) -> tuple[float, float]:
    """A y window that shows the function rather than its worst spike.

    Percentile-clipped: one pole would otherwise set the scale and flatten
    everything else into the axis.
    """
    if not values:
        return (-5.0, 5.0)
    ordered = sorted(values)
    count = len(ordered)
    low = ordered[int(0.02 * count)]
    high = ordered[min(count - 1, int(0.98 * count))]
    if high - low < 1e-9:
        low, high = low - 1.0, high + 1.0
    pad = (high - low) * 0.08
    return (low - pad, high + pad)


def sample_parametric(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """``(x(t), y(t))`` — expressions come in pairs."""
    if len(exprs) < 2:
        raise ValueError("a parametric plot needs at least two expressions: x(t) and y(t)")
    t_low, t_high = _range(ranges, "t", (0.0, 2 * math.pi))
    parameter = parse_symbol((ranges or {}).get("parameter", "t") if ranges else "t", default="t")

    series: list[Series] = []
    xs: list[float] = []
    ys: list[float] = []
    for pair_index in range(0, len(exprs) - 1, 2):
        fx = _compile(parse_math(exprs[pair_index], what="x(t)"), [parameter])
        fy = _compile(parse_math(exprs[pair_index + 1], what="y(t)"), [parameter])
        path: list[Point] = []
        for index in range(SAMPLES + 1):
            t = t_low + (t_high - t_low) * index / SAMPLES
            try:
                x, y = _real(fx(t)), _real(fy(t))
            except Exception:  # noqa: BLE001
                x = y = None
            if x is None or y is None:
                continue
            path.append((x, y))
            xs.append(x)
            ys.append(y)
        label = labels[pair_index // 2] if pair_index // 2 < len(labels) else f"curve {pair_index // 2 + 1}"
        series.append(Series(label=label, style="line", paths=[path] if len(path) > 1 else []))

    return PlotData(
        series=series,
        x_range=_range(ranges, "x", _auto_window(xs)),
        y_range=_range(ranges, "y", _auto_window(ys)),
        equal_aspect=True,
    )


def sample_polar(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """``r = f(θ)``, converted to Cartesian for drawing."""
    theta_low, theta_high = _range(ranges, "theta", (0.0, 2 * math.pi))
    theta = parse_symbol("theta", default="theta")

    series: list[Series] = []
    xs: list[float] = []
    ys: list[float] = []
    for index, text in enumerate(exprs):
        expr = parse_math(text, what="r(θ)")
        symbols = free_symbols_of(expr) or [theta]
        fn = _compile(expr, [symbols[0]])
        path: list[Point] = []
        for step in range(SAMPLES + 1):
            angle = theta_low + (theta_high - theta_low) * step / SAMPLES
            try:
                radius = _real(fn(angle))
            except Exception:  # noqa: BLE001
                radius = None
            if radius is None:
                continue
            x, y = radius * math.cos(angle), radius * math.sin(angle)
            path.append((x, y))
            xs.append(x)
            ys.append(y)
        series.append(
            Series(
                label=labels[index] if index < len(labels) else str(expr),
                style="line",
                paths=[path] if len(path) > 1 else [],
            )
        )

    return PlotData(
        series=series,
        x_range=_range(ranges, "x", _auto_window(xs)),
        y_range=_range(ranges, "y", _auto_window(ys)),
        equal_aspect=True,
    )


def sample_implicit(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """``F(x, y) = 0`` by marching squares on a grid.

    Contouring rather than solving: an implicit curve generally has no
    ``y = f(x)`` form, and the ones that do have several branches.
    """
    x_low, x_high = _range(ranges, "x", (-5.0, 5.0))
    y_low, y_high = _range(ranges, "y", (-5.0, 5.0))
    x_sym, y_sym = parse_symbol("x"), parse_symbol("y")
    steps = GRID_STEPS * 4

    series: list[Series] = []
    for index, text in enumerate(exprs):
        lhs, rhs = _implicit_sides(text)
        fn = _compile(sympy.together(lhs - rhs), [x_sym, y_sym])
        grid: list[list[float | None]] = []
        for row in range(steps + 1):
            y = y_low + (y_high - y_low) * row / steps
            line: list[float | None] = []
            for col in range(steps + 1):
                x = x_low + (x_high - x_low) * col / steps
                try:
                    line.append(_real(fn(x, y)))
                except Exception:  # noqa: BLE001
                    line.append(None)
            grid.append(line)
        segments = _marching_squares(grid, (x_low, x_high), (y_low, y_high), steps)
        series.append(
            Series(
                label=labels[index] if index < len(labels) else text,
                style="line",
                paths=segments,
            )
        )

    return PlotData(
        series=series,
        x_range=(x_low, x_high),
        y_range=(y_low, y_high),
        equal_aspect=True,
    )


def _implicit_sides(text: str) -> tuple[sympy.Expr, sympy.Expr]:
    from mathkit.parsing import parse_relation

    return parse_relation(text, what="the implicit equation")


def _marching_squares(
    grid: list[list[float | None]],
    x_range: tuple[float, float],
    y_range: tuple[float, float],
    steps: int,
) -> list[list[Point]]:
    """Zero-level segments of a sampled scalar field.

    Each cell contributes its own short segment; they are emitted unjoined
    because stitching them into long paths buys nothing at this resolution and
    costs a fiddly, bug-prone pass.
    """
    x_low, x_high = x_range
    y_low, y_high = y_range
    dx = (x_high - x_low) / steps
    dy = (y_high - y_low) / steps
    segments: list[list[Point]] = []

    for row in range(steps):
        for col in range(steps):
            corners = [
                (col, row),
                (col + 1, row),
                (col + 1, row + 1),
                (col, row + 1),
            ]
            values = [grid[r][c] for c, r in corners]
            if any(v is None for v in values):
                continue
            crossings: list[Point] = []
            for index in range(4):
                a, b = values[index], values[(index + 1) % 4]
                if a is None or b is None or (a > 0) == (b > 0):
                    continue
                ratio = a / (a - b) if a != b else 0.5
                (ca, ra), (cb, rb) = corners[index], corners[(index + 1) % 4]
                crossings.append(
                    (
                        x_low + dx * (ca + (cb - ca) * ratio),
                        y_low + dy * (ra + (rb - ra) * ratio),
                    )
                )
            if len(crossings) >= 2:
                segments.append(crossings[:2])
    return segments


def sample_field(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """A 2-D vector field ``(P(x,y), Q(x,y))`` as normalised arrows on a grid."""
    if len(exprs) < 2:
        raise ValueError("a field plot needs two expressions: the x and y components")
    x_low, x_high = _range(ranges, "x", (-5.0, 5.0))
    y_low, y_high = _range(ranges, "y", (-5.0, 5.0))
    x_sym, y_sym = parse_symbol("x"), parse_symbol("y")

    fp = _compile(parse_math(exprs[0], what="the x component"), [x_sym, y_sym])
    fq = _compile(parse_math(exprs[1], what="the y component"), [x_sym, y_sym])

    cell_x = (x_high - x_low) / FIELD_STEPS
    cell_y = (y_high - y_low) / FIELD_STEPS
    arrows: list[tuple[float, float, float, float]] = []
    for row in range(FIELD_STEPS + 1):
        for col in range(FIELD_STEPS + 1):
            x = x_low + cell_x * col
            y = y_low + cell_y * row
            try:
                u, v = _real(fp(x, y)), _real(fq(x, y))
            except Exception:  # noqa: BLE001
                continue
            if u is None or v is None:
                continue
            length = math.hypot(u, v)
            if length < 1e-12:
                continue
            # Normalised to the cell: an unnormalised field is one huge arrow
            # near a singularity and invisible everywhere else.
            scale = min(cell_x, cell_y) * 0.8 / length
            arrows.append((x, y, u * scale, v * scale))

    return PlotData(
        series=[Series(label=labels[0] if labels else "field", style="vector", vectors=arrows)],
        x_range=(x_low, x_high),
        y_range=(y_low, y_high),
        equal_aspect=True,
    )


def sample_surface(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """``z = f(x, y)`` as an isometric wireframe.

    A projection, not a render: without shading or hidden-surface removal a
    wireframe is the honest way to show a surface in flat SVG, and it stays
    readable in both themes.
    """
    x_low, x_high = _range(ranges, "x", (-3.0, 3.0))
    y_low, y_high = _range(ranges, "y", (-3.0, 3.0))
    x_sym, y_sym = parse_symbol("x"), parse_symbol("y")
    fn = _compile(parse_math(exprs[0], what="the surface"), [x_sym, y_sym])

    heights: list[list[float | None]] = []
    finite: list[float] = []
    for row in range(SURFACE_STEPS + 1):
        y = y_low + (y_high - y_low) * row / SURFACE_STEPS
        line: list[float | None] = []
        for col in range(SURFACE_STEPS + 1):
            x = x_low + (x_high - x_low) * col / SURFACE_STEPS
            try:
                z = _real(fn(x, y))
            except Exception:  # noqa: BLE001
                z = None
            line.append(z)
            if z is not None:
                finite.append(z)
        heights.append(line)

    z_low, z_high = _auto_window(finite)
    z_span = max(z_high - z_low, 1e-9)

    def project(x: float, y: float, z: float) -> Point:
        # Fixed isometric basis. Depth is folded into the horizontal axis and
        # height into the vertical one, which is all a wireframe needs.
        nx = (x - x_low) / max(x_high - x_low, 1e-9) - 0.5
        ny = (y - y_low) / max(y_high - y_low, 1e-9) - 0.5
        nz = (z - z_low) / z_span - 0.5
        return (nx - ny * 0.55, nz * 0.9 + ny * 0.42)

    paths: list[list[Point]] = []
    for row in range(SURFACE_STEPS + 1):
        line: list[Point] = []
        for col in range(SURFACE_STEPS + 1):
            z = heights[row][col]
            if z is None:
                continue
            line.append(project(
                x_low + (x_high - x_low) * col / SURFACE_STEPS,
                y_low + (y_high - y_low) * row / SURFACE_STEPS,
                z,
            ))
        if len(line) > 1:
            paths.append(line)
    for col in range(SURFACE_STEPS + 1):
        line = []
        for row in range(SURFACE_STEPS + 1):
            z = heights[row][col]
            if z is None:
                continue
            line.append(project(
                x_low + (x_high - x_low) * col / SURFACE_STEPS,
                y_low + (y_high - y_low) * row / SURFACE_STEPS,
                z,
            ))
        if len(line) > 1:
            paths.append(line)

    return PlotData(
        series=[Series(label=labels[0] if labels else str(exprs[0]), style="line", paths=paths)],
        x_range=(-1.1, 1.1),
        y_range=(-0.8, 0.8),
        x_label="",
        y_label="",
        notes=[f"isometric wireframe of z = {exprs[0]} over x∈[{x_low:g},{x_high:g}], y∈[{y_low:g},{y_high:g}]"],
    )


def sample_discrete(exprs: list[str], ranges: dict[str, Any] | None, labels: list[str]) -> PlotData:
    """A sequence ``a(n)`` over integer n — stems, not a curve."""
    n_low, n_high = _range(ranges, "n", (0.0, 20.0))
    index_symbol = parse_symbol((ranges or {}).get("index", "n") if ranges else "n", default="n")
    start, stop = int(math.floor(n_low)), int(math.ceil(n_high))
    if stop - start > 2000:
        raise ValueError("a discrete plot is limited to 2000 points")

    series: list[Series] = []
    values: list[float] = []
    for position, text in enumerate(exprs):
        fn = _compile(parse_math(text, what="the sequence"), [index_symbol])
        points: list[Point] = []
        for n in range(start, stop + 1):
            try:
                value = _real(fn(n))
            except Exception:  # noqa: BLE001
                value = None
            if value is None:
                continue
            points.append((float(n), value))
            values.append(value)
        series.append(
            Series(
                label=labels[position] if position < len(labels) else text,
                style="stem",
                points=points,
            )
        )

    return PlotData(
        series=series,
        x_range=(start - 0.5, stop + 0.5),
        y_range=_range(ranges, "y", _auto_window(values)),
        x_label="n",
    )


SAMPLERS: dict[str, Callable[[list[str], dict[str, Any] | None, list[str]], PlotData]] = {
    "cartesian": sample_cartesian,
    "parametric": sample_parametric,
    "polar": sample_polar,
    "implicit": sample_implicit,
    "field": sample_field,
    "surface": sample_surface,
    "discrete": sample_discrete,
}
