"""The math engine: safe parsing, per-kind verification, sampling and plotting.

Deliberately import-free. ``mathkit.worker`` is imported by a *child process*
that must pay for sympy exactly once and only when a math tool is actually
called; an eager re-export here would drag sympy into every backend start.
"""

from __future__ import annotations
