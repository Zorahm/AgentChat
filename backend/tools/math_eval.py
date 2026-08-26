"""math_eval — a preconfigured calculator, not a second shell.

An escape hatch for the arithmetic that no verifier kind covers: a quick
numeric evaluation, a table of values, a series expansion. It runs in the math
worker with sympy / mpmath / numpy already imported and a closed namespace, so
an agent that has been given no shell can still compute — which is the whole
reason it exists next to ``bash_tool`` rather than instead of it.

Deliberately NOT the place to produce answers from. A solution whose reasoning
is "I called sympy.solve and here are the roots" is a worse answer than one that
explains the method, however correct the roots are.
"""

from __future__ import annotations

from mathkit.runner import MathWorkerError, MathWorkerPool
from tools.base import BaseTool, ToolDefinition, ToolSchema

DEFAULT_TIMEOUT = 10
MAX_TIMEOUT = 60


class MathEvalTool(BaseTool):
    """Run a short Python calculation with the maths stack preloaded."""

    name = "math_eval"
    description = (
        "Run a short Python calculation with sympy (also as `sp`), numpy (`np`), "
        "mpmath, math, random, itertools and fractions already imported — no import "
        "statement is allowed or needed. Returns stdout plus the value of the last "
        "expression, REPL-style. Use it for arithmetic you should not do in your "
        "head: evaluating a messy expression, checking a coefficient, tabulating "
        "values, expanding a series. It is a calculator, not a solver — never "
        "present its output as the solution; work the problem through and use this "
        "to keep the numbers honest. No filesystem, no network, no imports."
    )

    def __init__(self, pool: MathWorkerPool) -> None:
        self._pool = pool

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": (
                                "Python to run. The value of the final expression comes "
                                "back as `result`, so end with the thing you want to see. "
                                "`print()` also works."
                            ),
                        },
                        "timeout_s": {
                            "type": "integer",
                            "description": (
                                f"Seconds to allow, {DEFAULT_TIMEOUT} by default, "
                                f"{MAX_TIMEOUT} at most. Raise it only for a calculation "
                                "you expect to be slow."
                            ),
                        },
                    },
                    "required": ["code"],
                },
            )
        )

    async def execute(self, code: str = "", timeout_s: int = DEFAULT_TIMEOUT) -> str:  # type: ignore[override]
        if not isinstance(code, str) or not code.strip():
            return "Error: math_eval needs a non-empty 'code' string."

        try:
            budget = max(1, min(int(timeout_s), MAX_TIMEOUT))
        except (TypeError, ValueError):
            budget = DEFAULT_TIMEOUT

        try:
            # The worker's own budget is a little longer than the tool's, so a
            # timeout is reported as one rather than racing the pool's kill.
            result = await self._pool.submit("eval", {"code": code}, timeout=budget + 2.0)
        except MathWorkerError as exc:
            return f"Error: {exc}"

        parts: list[str] = []
        stdout = str(result.get("stdout") or "")
        if stdout.strip():
            parts.append(stdout.rstrip())
        value = result.get("result")
        if value is not None:
            parts.append(f"=> {value}")
        error = result.get("error")
        if error:
            parts.append(f"[error] {error}")
        return "\n".join(parts) if parts else "(no output — the code produced nothing)"
