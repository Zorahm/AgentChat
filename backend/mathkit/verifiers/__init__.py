"""Per-kind verification strategies.

Import-free by design: every module in here imports sympy, and the package is
reached only from inside the worker process. See ``mathkit.verifiers.registry``
for the kind → strategy table.
"""

from __future__ import annotations
