"""Render :class:`PlotData` as one self-contained, theme-aware SVG.

Colours are CSS variables with literal fallbacks, never bare hex. Inside the
chat the widget host injects the app's tokens, so the plot follows light/dark
along with everything else; saved to disk or opened on its own, the fallbacks
keep it legible. Nothing here loads a font, a script or an image, which is what
makes the output exportable as a single file.
"""

from __future__ import annotations

import math
import re
from typing import Any
from xml.sax.saxutils import escape

from mathkit.plot.sampler import PlotData, Point, Series

WIDTH = 760
HEIGHT = 460
MARGIN_LEFT = 62
MARGIN_RIGHT = 24
MARGIN_TOP = 40
MARGIN_BOTTOM = 52

# Bounds for the canvas when a plot demands equal axis scaling. Below the floor
# a wide-and-flat curve becomes an unreadable strip; above the ceiling a tall
# one pushes the rest of the reply off the screen.
MIN_PLOT_HEIGHT = 200
MAX_PLOT_HEIGHT = 620

# Eight is what the token set carries; a ninth series wraps rather than
# inventing a colour that no theme defines.
SERIES_COLORS = [f"var(--chart-{i}, {c})" for i, c in enumerate(
    ["#4f9dde", "#e07a5f", "#81b29a", "#c77dff", "#f2cc8f", "#7c6fdc", "#e5989b", "#52b788"],
    start=1,
)]

_FG = "var(--fg, #1c1c1c)"
_MUTED = "var(--muted, #6b6b6b)"
_GRID = "var(--grid, rgba(128,128,128,0.18))"
_AXIS = "var(--axis, rgba(128,128,128,0.55))"
_ACCENT = "var(--accent, #7c6fdc)"
_FONT = "var(--font-sans, system-ui, sans-serif)"


class _Projection:
    """Data coordinates → SVG user units, with the y axis flipped.

    Owns the canvas height, because plots where the *shape* carries the meaning
    have to be drawn with one unit of x the same size as one unit of y. Without
    that, ``x² + y² = 4`` came out as a wide ellipse: identical −3…3 ranges on
    both axes, squeezed into a 674×368 box. A circle rendered as an ellipse is
    not a rough picture, it is a wrong one.
    """

    def __init__(self, data: PlotData) -> None:
        self.x_low, self.x_high = data.x_range
        self.y_low, self.y_high = data.y_range
        if self.x_high - self.x_low < 1e-12:
            self.x_low, self.x_high = self.x_low - 1.0, self.x_high + 1.0
        if self.y_high - self.y_low < 1e-12:
            self.y_low, self.y_high = self.y_low - 1.0, self.y_high + 1.0
        self.plot_width = WIDTH - MARGIN_LEFT - MARGIN_RIGHT
        self.plot_height = HEIGHT - MARGIN_TOP - MARGIN_BOTTOM

        if getattr(data, "equal_aspect", False):
            self._equalise()

        self.height = MARGIN_TOP + self.plot_height + MARGIN_BOTTOM

    def _equalise(self) -> None:
        """Give x and y the same pixels-per-unit.

        The canvas grows or shrinks to fit the data's own aspect. When that would
        make it unreadably flat or absurdly tall the canvas is clamped instead,
        and the *shorter* axis is widened to take up the slack — still equal
        scaling, just with more empty space than the caller asked for.
        """
        x_span = self.x_high - self.x_low
        y_span = self.y_high - self.y_low
        wanted = self.plot_width * (y_span / x_span)

        if MIN_PLOT_HEIGHT <= wanted <= MAX_PLOT_HEIGHT:
            self.plot_height = wanted
            return

        self.plot_height = min(max(wanted, MIN_PLOT_HEIGHT), MAX_PLOT_HEIGHT)
        scale = min(self.plot_width / x_span, self.plot_height / y_span)
        self._widen_x(self.plot_width / scale - x_span)
        self._widen_y(self.plot_height / scale - y_span)

    def _widen_x(self, extra: float) -> None:
        if extra > 0:
            self.x_low -= extra / 2
            self.x_high += extra / 2

    def _widen_y(self, extra: float) -> None:
        if extra > 0:
            self.y_low -= extra / 2
            self.y_high += extra / 2

    def x(self, value: float) -> float:
        ratio = (value - self.x_low) / (self.x_high - self.x_low)
        return MARGIN_LEFT + ratio * self.plot_width

    def y(self, value: float) -> float:
        ratio = (value - self.y_low) / (self.y_high - self.y_low)
        return MARGIN_TOP + (1.0 - ratio) * self.plot_height

    def inside_x(self, value: float) -> bool:
        return self.x_low - 1e-9 <= value <= self.x_high + 1e-9


def _ticks(low: float, high: float, target: int = 8) -> list[float]:
    """Round tick values at a 1/2/5×10ⁿ step — the spacing people read fastest."""
    span = high - low
    if span <= 0:
        return [low]
    raw = span / max(target, 2)
    magnitude = 10 ** math.floor(math.log10(raw))
    for multiple in (1, 2, 5, 10):
        step = multiple * magnitude
        if raw <= step:
            break
    first = math.ceil(low / step) * step
    out: list[float] = []
    value = first
    while value <= high + step * 1e-6 and len(out) < 40:
        out.append(0.0 if abs(value) < step * 1e-9 else value)
        value += step
    return out


def _fmt_tick(value: float) -> str:
    if value == 0:
        return "0"
    if abs(value) >= 1e4 or abs(value) < 1e-3:
        return f"{value:.1e}"
    text = f"{value:.6g}"
    return text


def _path_d(path: list[Point], projection: _Projection) -> str:
    parts: list[str] = []
    for index, (x, y) in enumerate(path):
        command = "M" if index == 0 else "L"
        parts.append(f"{command}{projection.x(x):.2f} {projection.y(y):.2f}")
    return "".join(parts)


def _clip_to_view(path: list[Point], projection: _Projection) -> list[list[Point]]:
    """Drop runs that leave the y window, so a curve doesn't paint over the axes.

    Done in data space rather than with an SVG clipPath because a clipPath still
    renders the off-screen geometry into the exported file.
    """
    pad = (projection.y_high - projection.y_low) * 0.5
    low, high = projection.y_low - pad, projection.y_high + pad
    runs: list[list[Point]] = []
    current: list[Point] = []
    for point in path:
        if low <= point[1] <= high:
            current.append(point)
        elif len(current) > 1:
            runs.append(current)
            current = []
        else:
            current = []
    if len(current) > 1:
        runs.append(current)
    return runs


def _axes(projection: _Projection, data: PlotData) -> list[str]:
    out: list[str] = []
    for value in _ticks(projection.x_low, projection.x_high):
        x = projection.x(value)
        out.append(
            f'<line x1="{x:.2f}" y1="{MARGIN_TOP}" x2="{x:.2f}" '
            f'y2="{projection.height - MARGIN_BOTTOM}" stroke="{_GRID}" stroke-width="1"/>'
        )
        out.append(
            f'<text x="{x:.2f}" y="{projection.height - MARGIN_BOTTOM + 18}" fill="{_MUTED}" '
            f'font-size="11" font-family="{_FONT}" text-anchor="middle">{_fmt_tick(value)}</text>'
        )
    for value in _ticks(projection.y_low, projection.y_high, target=6):
        y = projection.y(value)
        out.append(
            f'<line x1="{MARGIN_LEFT}" y1="{y:.2f}" x2="{WIDTH - MARGIN_RIGHT}" '
            f'y2="{y:.2f}" stroke="{_GRID}" stroke-width="1"/>'
        )
        out.append(
            f'<text x="{MARGIN_LEFT - 8}" y="{y + 4:.2f}" fill="{_MUTED}" font-size="11" '
            f'font-family="{_FONT}" text-anchor="end">{_fmt_tick(value)}</text>'
        )

    if projection.y_low <= 0 <= projection.y_high:
        y = projection.y(0.0)
        out.append(
            f'<line x1="{MARGIN_LEFT}" y1="{y:.2f}" x2="{WIDTH - MARGIN_RIGHT}" y2="{y:.2f}" '
            f'stroke="{_AXIS}" stroke-width="1.4"/>'
        )
    if projection.x_low <= 0 <= projection.x_high:
        x = projection.x(0.0)
        out.append(
            f'<line x1="{x:.2f}" y1="{MARGIN_TOP}" x2="{x:.2f}" '
            f'y2="{projection.height - MARGIN_BOTTOM}" stroke="{_AXIS}" stroke-width="1.4"/>'
        )

    if data.x_label:
        out.append(
            f'<text x="{WIDTH - MARGIN_RIGHT}" y="{projection.height - 14}" fill="{_MUTED}" '
            f'font-size="12" font-family="{_FONT}" text-anchor="end">{escape(data.x_label)}</text>'
        )
    if data.y_label:
        # Below the title, not beside it — at MARGIN_TOP − 14 the two sat on the
        # same line and the axis name ran into the plot's own heading.
        out.append(
            f'<text x="{MARGIN_LEFT - 46}" y="{MARGIN_TOP + 4}" fill="{_MUTED}" font-size="12" '
            f'font-family="{_FONT}">{escape(data.y_label)}</text>'
        )
    return out


def _draw_series(series: Series, color: str, projection: _Projection) -> list[str]:
    out: list[str] = []
    for path in series.paths:
        for run in _clip_to_view(path, projection):
            out.append(
                f'<path d="{_path_d(run, projection)}" fill="none" stroke="{color}" '
                'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
            )
    if series.style == "stem":
        baseline = projection.y(max(projection.y_low, min(0.0, projection.y_high)))
        for x, y in series.points:
            if not projection.inside_x(x):
                continue
            out.append(
                f'<line x1="{projection.x(x):.2f}" y1="{baseline:.2f}" '
                f'x2="{projection.x(x):.2f}" y2="{projection.y(y):.2f}" '
                f'stroke="{color}" stroke-width="1.5" opacity="0.55"/>'
            )
    for x, y in series.points:
        if not projection.inside_x(x):
            continue
        out.append(
            f'<circle cx="{projection.x(x):.2f}" cy="{projection.y(y):.2f}" r="3" fill="{color}"/>'
        )
    for x, y, dx, dy in series.vectors:
        x1, y1 = projection.x(x), projection.y(y)
        x2, y2 = projection.x(x + dx), projection.y(y + dy)
        out.append(
            f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" stroke="{color}" '
            'stroke-width="1.3" marker-end="url(#mk-arrow)" opacity="0.85"/>'
        )
    return out


Box = tuple[float, float, float, float]

# No font metrics without a font, so widths are estimated — and the estimate is
# deliberately generous. Erring narrow is what lets two labels touch: at 6.4 px
# per character "вершина" was measured as 45 px against a real 49, and the two
# px of overlap that bought put it straight through its neighbour. Cyrillic and
# accented text run wider than ASCII, so the bias goes the other way and the
# cost of being wrong is a little extra space.
_CHAR_WIDTH = 7.2
_LABEL_HEIGHT = 14.0
_LABEL_PAD = 4.0

# Tried in order, as (dx, dy) from the marked point. Right-and-above first,
# because that is where a reader looks; the rest are fallbacks for when the
# obvious spot is taken.
_LABEL_OFFSETS: tuple[tuple[float, float], ...] = (
    (9, -8), (9, 18), (-9, -8), (-9, 18), (9, -24), (-9, -24), (9, 32), (-9, 32),
)


def _overlaps(box: Box, others: list[Box]) -> bool:
    left, top, right, bottom = box
    for other in others:
        if left < other[2] and right > other[0] and top < other[3] and bottom > other[1]:
            return True
    return False


def _place_label(text: str, x: float, y: float, placed: list[Box]) -> str:
    """Draw a point's label somewhere it doesn't sit on top of another one.

    Three annotated points on one parabola used to stack their captions into an
    unreadable smear, because every label took the same fixed offset. Each label
    now claims a box and the next one steps around it.
    """
    width = len(text) * _CHAR_WIDTH
    for dx, dy in _LABEL_OFFSETS:
        left = x + dx if dx > 0 else x + dx - width
        box: Box = (
            left - _LABEL_PAD,
            y + dy - _LABEL_HEIGHT,
            left + width + _LABEL_PAD,
            y + dy + _LABEL_PAD,
        )
        if not _overlaps(box, placed):
            placed.append(box)
            anchor = "start" if dx > 0 else "end"
            return (
                f'<text x="{x + dx:.2f}" y="{y + dy:.2f}" fill="{_FG}" font-size="12" '
                f'font-family="{_FONT}" text-anchor="{anchor}">{escape(text)}</text>'
            )
    # Every slot taken — draw it anyway rather than silently losing the label.
    return (
        f'<text x="{x + 9:.2f}" y="{y - 8:.2f}" fill="{_FG}" font-size="12" '
        f'font-family="{_FONT}">{escape(text)}</text>'
    )


def _annotations(items: list[dict[str, Any]], data: PlotData, projection: _Projection) -> list[str]:
    out: list[str] = []
    placed: list[Box] = []
    for item in items:
        kind = str(item.get("kind") or item.get("type") or "").lower()
        label = str(item.get("label") or item.get("text") or "")
        try:
            if kind == "point":
                x, y = float(item["x"]), float(item["y"])
                out.append(
                    f'<circle cx="{projection.x(x):.2f}" cy="{projection.y(y):.2f}" r="5" '
                    f'fill="var(--bg, #fff)" stroke="{_ACCENT}" stroke-width="2.5"/>'
                )
                if label:
                    out.append(_place_label(label, projection.x(x), projection.y(y), placed))
            elif kind in ("vline", "asymptote", "vertical"):
                x = projection.x(float(item["x"]))
                out.append(
                    f'<line x1="{x:.2f}" y1="{MARGIN_TOP}" x2="{x:.2f}" '
                    f'y2="{projection.height - MARGIN_BOTTOM}" stroke="{_ACCENT}" '
                    'stroke-width="1.5" stroke-dasharray="6 4" opacity="0.8"/>'
                )
                if label:
                    out.append(
                        f'<text x="{x + 6:.2f}" y="{MARGIN_TOP + 14}" fill="{_ACCENT}" '
                        f'font-size="11" font-family="{_FONT}">{escape(label)}</text>'
                    )
            elif kind in ("hline", "horizontal"):
                y = projection.y(float(item["y"]))
                out.append(
                    f'<line x1="{MARGIN_LEFT}" y1="{y:.2f}" x2="{WIDTH - MARGIN_RIGHT}" '
                    f'y2="{y:.2f}" stroke="{_ACCENT}" stroke-width="1.5" '
                    'stroke-dasharray="6 4" opacity="0.8"/>'
                )
            elif kind in ("area", "fill"):
                out.extend(_area(item, data, projection))
            elif kind == "label":
                out.append(
                    f'<text x="{projection.x(float(item["x"])):.2f}" '
                    f'y="{projection.y(float(item["y"])):.2f}" fill="{_FG}" font-size="12" '
                    f'font-family="{_FONT}">{escape(label)}</text>'
                )
        except (KeyError, TypeError, ValueError):
            continue  # a malformed annotation must not lose the whole plot
    return out


def _area(item: dict[str, Any], data: PlotData, projection: _Projection) -> list[str]:
    """Shade under one series between two x values."""
    index = int(item.get("series", item.get("expr_index", 0)) or 0)
    if not (0 <= index < len(data.series)):
        return []
    low = float(item.get("from", item.get("a", projection.x_low)))
    high = float(item.get("to", item.get("b", projection.x_high)))
    if high < low:
        low, high = high, low

    baseline = projection.y(max(projection.y_low, min(0.0, projection.y_high)))
    out: list[str] = []
    for path in data.series[index].paths:
        span = [p for p in path if low - 1e-9 <= p[0] <= high + 1e-9]
        if len(span) < 2:
            continue
        points = " ".join(f"{projection.x(x):.2f},{projection.y(y):.2f}" for x, y in span)
        first_x, last_x = projection.x(span[0][0]), projection.x(span[-1][0])
        out.append(
            f'<polygon points="{first_x:.2f},{baseline:.2f} {points} {last_x:.2f},{baseline:.2f}" '
            f'fill="{_ACCENT}" opacity="0.18"/>'
        )
    return out


_SUPERSCRIPT = str.maketrans("0123456789+-n", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ")
_POWER = re.compile(r"\*\*\(?(-?[0-9n]+)\)?")


def pretty_expr(text: str) -> str:
    """Make a SymPy source string readable in a legend.

    ``x**2 - 5*x + 6`` reads as code, and a legend is the one place the reader
    meets the expression as *mathematics*. Superscripts and a real multiplication
    sign are most of the distance, and neither can turn a correct expression into
    a wrong one — which rules out the tempting step of dropping the ``*``
    entirely, since ``5x`` and ``5*x`` part company the moment a name is longer
    than one letter.
    """
    out = _POWER.sub(lambda m: m.group(1).translate(_SUPERSCRIPT), text)
    return out.replace("*", "·").replace("<=", "≤").replace(">=", "≥")


def _legend(data: PlotData, projection: _Projection) -> list[str]:
    labelled = [s for s in data.series if s.label]
    if len(labelled) < 1:
        return []
    out: list[str] = []
    x = MARGIN_LEFT
    y = projection.height - 16
    for index, series in enumerate(labelled[:6]):
        color = SERIES_COLORS[index % len(SERIES_COLORS)]
        out.append(
            f'<rect x="{x}" y="{y - 8}" width="14" height="3" rx="1.5" fill="{color}"/>'
        )
        pretty = pretty_expr(series.label)
        text = pretty if len(pretty) <= 28 else pretty[:27] + "…"
        out.append(
            f'<text x="{x + 20}" y="{y - 2}" fill="{_MUTED}" font-size="11" '
            f'font-family="{_FONT}">{escape(text)}</text>'
        )
        x += 34 + len(text) * 6.2
    return out


def render_svg(data: PlotData, annotations: list[dict[str, Any]] | None = None) -> str:
    """The finished document: one ``<svg>`` element, no external references."""
    projection = _Projection(data)
    body: list[str] = [
        '<defs><marker id="mk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" '
        'markerHeight="5" orient="auto-start-reverse">'
        f'<path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>',
        f'<rect x="0" y="0" width="{WIDTH}" height="{projection.height:.0f}" '
        'fill="var(--bg, transparent)"/>',
    ]
    body += _axes(projection, data)
    for index, series in enumerate(data.series):
        color = SERIES_COLORS[index % len(SERIES_COLORS)]
        body.append(f'<g color="{color}">')
        body += _draw_series(series, color, projection)
        body.append("</g>")
    body += _annotations(annotations or [], data, projection)
    body += _legend(data, projection)

    if data.title:
        body.append(
            f'<text x="{MARGIN_LEFT}" y="{MARGIN_TOP - 16}" fill="{_FG}" font-size="14" '
            f'font-weight="600" font-family="{_FONT}">{escape(data.title)}</text>'
        )
    for offset, note in enumerate(data.notes[:2]):
        body.append(
            f'<text x="{WIDTH - MARGIN_RIGHT}" y="{MARGIN_TOP - 16 + offset * 14}" fill="{_MUTED}" '
            f'font-size="11" font-family="{_FONT}" text-anchor="end">{escape(note)}</text>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {projection.height:.0f}" '
        f'width="100%" role="img" aria-label="{escape(data.title or "plot")}">'
        + "".join(body)
        + "</svg>"
    )
