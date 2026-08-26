"""Server-side plotting: expression in, self-contained themed SVG out.

The model says *what* to draw; this package decides *how*. That split is the
whole point — asked for a chart directly, a model writes 150 lines of chart
library setup, differently every time, and the result depends on a CDN being
reachable at render time. Here the picture is a single inline SVG built from
theme tokens, so it works offline, exports as-is, and looks the same twice.

Import-free on purpose: ``mathkit.plot.render`` pulls sympy in, and only the
worker process should pay for that.
"""

from __future__ import annotations
