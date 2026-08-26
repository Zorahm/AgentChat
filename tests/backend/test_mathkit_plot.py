"""math_plot's renderer: every kind draws, and nothing reaches for the network.

The self-containment assertions are the load-bearing ones. The whole reason
plotting is a backend tool rather than model-written chart HTML is that the
picture has to appear with no CDN reachable — an offline app whose graphs are
blank rectangles has not solved "describe the graph in words".
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from mathkit.plot.render import render_plot  # noqa: E402


def render(kind: str, exprs: list[str], **extra: Any) -> dict[str, Any]:
    return render_plot({"kind": kind, "exprs": exprs, **extra})


@pytest.mark.parametrize(
    ("kind", "exprs", "ranges"),
    [
        ("cartesian", ["sin(x)", "x**2/10"], {"x": [-6, 6]}),
        ("parametric", ["cos(3*t)", "sin(2*t)"], {"t": [0, 6.2832]}),
        ("polar", ["1 + cos(theta)"], {"theta": [0, 6.2832]}),
        ("implicit", ["x**2 + y**2 = 4"], {"x": [-3, 3], "y": [-3, 3]}),
        ("field", ["-y", "x"], {"x": [-3, 3], "y": [-3, 3]}),
        ("surface", ["sin(x)*cos(y)"], {"x": [-3, 3], "y": [-3, 3]}),
        ("discrete", ["1/n"], {"n": [1, 20]}),
    ],
)
def test_every_kind_renders(kind: str, exprs: list[str], ranges: dict[str, Any]) -> None:
    result = render(kind, exprs, ranges=ranges)
    assert "error" not in result, result.get("error")
    assert result["svg"].startswith("<svg") and result["svg"].endswith("</svg>")


def test_the_svg_is_self_contained() -> None:
    """No CDN, no font fetch, no data URI — it must draw with the network down."""
    svg = render("cartesian", ["sin(x)"], ranges={"x": [-6, 6]})["svg"]
    # The SVG namespace declaration is the one URL that is not a fetch.
    body = svg.replace('xmlns="http://www.w3.org/2000/svg"', "")
    for forbidden in ("http://", "https://", "<script", "@import", "xlink:href", "data:"):
        assert forbidden not in body


def test_colours_are_theme_tokens_not_hardcoded() -> None:
    """A plot drawn in fixed colours is unreadable in one of the two themes."""
    svg = render("cartesian", ["sin(x)"], ranges={"x": [-6, 6]})["svg"]
    assert "var(--chart-1" in svg
    assert "var(--fg" in svg or "var(--muted" in svg


def test_a_pole_breaks_the_curve_instead_of_drawing_a_false_asymptote() -> None:
    """tan(x) sampled naively is one polyline racing from +inf to -inf."""
    result = render("cartesian", ["tan(x)"], ranges={"x": [-5, 5], "y": [-6, 6]})
    assert result["svg"].count("<path") > 1


def test_annotations_land_on_the_picture() -> None:
    result = render(
        "cartesian",
        ["sin(x)"],
        ranges={"x": [-6, 6]},
        annotations=[
            {"kind": "point", "x": 0, "y": 0, "label": "origin"},
            {"kind": "vline", "x": 3.14159, "label": "pi"},
            {"kind": "area", "series": 0, "from": 0, "to": 3.14159},
        ],
    )
    assert "origin" in result["svg"]
    assert "<polygon" in result["svg"]  # the shaded area
    assert "stroke-dasharray" in result["svg"]  # the asymptote line


def test_a_tangent_annotation_becomes_a_real_line() -> None:
    """Differentiating is mathematics, so it happens before the renderer sees it."""
    result = render(
        "cartesian",
        ["x**2"],
        ranges={"x": [-3, 3]},
        annotations=[{"kind": "tangent", "series": 0, "at": 1}],
    )
    assert result["series"] == 2
    assert "tangent" in result["svg"]


def test_a_malformed_annotation_does_not_lose_the_plot() -> None:
    result = render(
        "cartesian",
        ["sin(x)"],
        ranges={"x": [-6, 6]},
        annotations=[{"kind": "point", "x": "not a number"}],
    )
    assert "error" not in result


def _viewbox(svg: str) -> tuple[float, float]:
    match = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    assert match, "no viewBox"
    return float(match.group(1)), float(match.group(2))


@pytest.mark.parametrize(
    ("kind", "exprs", "ranges"),
    [
        ("implicit", ["x**2 + y**2 = 4"], {"x": [-3, 3], "y": [-3, 3]}),
        ("polar", ["1 + cos(theta)"], {"theta": [0, 6.2832]}),
        ("parametric", ["cos(3*t)", "sin(2*t)"], {"t": [0, 6.2832]}),
        ("field", ["-y", "x"], {"x": [-3, 3], "y": [-3, 3]}),
    ],
)
def test_shape_carrying_plots_get_equal_axis_scaling(
    kind: str, exprs: list[str], ranges: dict[str, Any]
) -> None:
    """A circle has to come out round.

    ``x² + y² = 4`` used to render as a wide ellipse: identical −3…3 ranges on
    both axes, drawn into a 674×368 box. Where the *shape* is the content, one
    unit of x must occupy the same number of pixels as one unit of y.
    """
    from mathkit.plot.sampler import SAMPLERS
    from mathkit.plot.svg import MARGIN_BOTTOM, MARGIN_LEFT, MARGIN_RIGHT, MARGIN_TOP, WIDTH

    data = SAMPLERS[kind](exprs, ranges, [])
    assert data.equal_aspect, f"{kind} should be drawn to scale"

    svg = render(kind, exprs, ranges=ranges)["svg"]
    _, height = _viewbox(svg)
    plot_width = WIDTH - MARGIN_LEFT - MARGIN_RIGHT
    plot_height = height - MARGIN_TOP - MARGIN_BOTTOM

    # The renderer may widen a range to fit its clamp, so compare the scales the
    # *rendered* window implies rather than the sampler's original ranges.
    from mathkit.plot.svg import _Projection

    projection = _Projection(data)
    scale_x = plot_width / (projection.x_high - projection.x_low)
    scale_y = plot_height / (projection.y_high - projection.y_low)
    assert abs(scale_x - scale_y) / scale_x < 0.01, f"{scale_x=} {scale_y=}"


def test_a_plain_function_plot_is_not_forced_to_scale() -> None:
    """y = f(x) measures unrelated quantities on the two axes; equalising them
    would squash an ordinary curve into a line."""
    from mathkit.plot.sampler import SAMPLERS

    data = SAMPLERS["cartesian"](["exp(x)"], {"x": [0, 12]}, [])
    assert not data.equal_aspect
    _, height = _viewbox(render("cartesian", ["exp(x)"], ranges={"x": [0, 12]})["svg"])
    assert height == 460


def test_crowded_point_labels_do_not_overlap() -> None:
    """Three annotated points on one parabola used to stack their captions into
    an unreadable smear, because every label took the same fixed offset."""
    svg = render(
        "cartesian",
        ["x**2 - 5*x + 6"],
        ranges={"x": [-1, 6]},
        annotations=[
            {"kind": "point", "x": 2, "y": 0, "label": "x1=2"},
            {"kind": "point", "x": 2.5, "y": -0.25, "label": "вершина"},
            {"kind": "point", "x": 3, "y": 0, "label": "x2=3"},
        ],
    )["svg"]
    placed = re.findall(r'<text x="([\d.]+)" y="([\d.]+)"[^>]*>(x1=2|вершина|x2=3)</text>', svg)
    assert len(placed) == 3, placed
    # Distinct anchors: two labels sharing a spot is exactly the bug.
    assert len({(x, y) for x, y, _ in placed}) == 3


def test_the_legend_reads_as_maths_not_as_source() -> None:
    from mathkit.plot.svg import pretty_expr

    assert pretty_expr("x**2 - 5*x + 6") == "x² - 5·x + 6"
    assert pretty_expr("x**(-1)") == "x⁻¹"
    # The `*` survives: dropping it turns `5*xy` into `5xy`, a different thing.
    assert "·" in pretty_expr("2*alpha")


def test_an_unknown_kind_names_the_real_ones() -> None:
    result = render("hologram", ["x"])
    assert "cartesian" in result["error"]


def test_a_range_with_no_finite_values_is_an_error_not_a_blank_card() -> None:
    result = render("cartesian", ["log(x)"], ranges={"x": [-9, -2]})
    assert "nothing was drawable" in result["error"]


def test_no_expressions_is_an_error() -> None:
    assert "error" in render("cartesian", [])


def test_too_many_expressions_is_refused() -> None:
    assert "error" in render("cartesian", [f"x + {i}" for i in range(12)])


def test_labels_reach_the_output() -> None:
    result = render(
        "cartesian",
        ["sin(x)"],
        ranges={"x": [-6, 6]},
        labels={"title": "a wave", "x": "time", "series": ["displacement"]},
    )
    assert "a wave" in result["svg"] and "displacement" in result["svg"]


def test_labels_are_escaped() -> None:
    """The title is model-written text going into markup."""
    result = render("cartesian", ["sin(x)"], ranges={"x": [-6, 6]},
                    labels={"title": "<script>alert(1)</script>"})
    assert "<script" not in result["svg"]
    assert "&lt;script&gt;" in result["svg"]
