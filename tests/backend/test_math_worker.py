"""End-to-end through a real worker process.

Everything else in the math tests mocks the pool. This file does not: it spawns
the child, speaks the line-delimited JSON protocol, and reads a real verdict
back. That covers the seams nothing else does — the argv the parent builds, the
readiness handshake, the JSON framing, and whether the parent can still work
after it has killed a worker mid-calculation.

Slower than the rest (the child pays sympy's import once), which is the whole
reason the pool keeps workers warm.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import time
from pathlib import Path
from typing import Any, Coroutine, TypeVar

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from mathkit.runner import MathWorkerError, MathWorkerPool  # noqa: E402
from tools.math_verify import MathVerifyTool  # noqa: E402

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("sympy") is None,
    reason="sympy is not installed in this environment",
)

T = TypeVar("T")


def run(coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


@pytest.mark.skipif(sys.platform != "win32", reason="the loop split only exists on Windows")
def test_the_worker_runs_on_a_selector_event_loop() -> None:
    """The loop the server runs on is not ours to choose.

    ``asyncio.create_subprocess_exec`` only works on Windows under a
    ProactorEventLoop, and uvicorn sometimes installs a SelectorEventLoop —
    where it raises ``NotImplementedError`` with an EMPTY message. Every math
    tool then failed with a bare "Error: math_plot failed — ", which named
    neither the cause nor the layer. Regression-tested here because a developer
    box defaults to Proactor, so the bug is invisible in every other test.
    """
    loop = asyncio.SelectorEventLoop()
    asyncio.set_event_loop(loop)

    async def scenario() -> dict[str, object]:
        pool = MathWorkerPool(size=1, timeout=60.0)
        try:
            return await pool.submit(
                "plot", {"kind": "cartesian", "exprs": ["x**2"], "ranges": {"x": [0, 5]}}
            )
        finally:
            await pool.shutdown()

    try:
        result = loop.run_until_complete(scenario())
    finally:
        loop.close()
        asyncio.set_event_loop(None)

    assert str(result.get("svg", "")).startswith("<svg")


def test_a_real_verdict_comes_back_through_the_tool() -> None:
    pool = MathWorkerPool(size=1, timeout=40.0)

    async def scenario() -> str:
        tool = MathVerifyTool(pool)
        try:
            return await tool.execute(
                kind="integral_indef",
                problem="find the antiderivative of x*exp(x)",
                claim={
                    "integrand": "x*exp(x)",
                    "variable": "x",
                    "antiderivative": "(x-1)*exp(x)",
                },
            )
        finally:
            await pool.shutdown()

    text = run(scenario())
    assert "VERIFIED" in text
    assert "differentiated" in text


def test_a_wrong_answer_comes_back_refuted_with_a_point() -> None:
    pool = MathWorkerPool(size=1, timeout=40.0)

    async def scenario() -> str:
        tool = MathVerifyTool(pool)
        try:
            return await tool.execute(
                kind="derivative",
                problem="differentiate x^3",
                claim={"function": "x**3", "variable": "x", "derivative": "2*x**2"},
            )
        finally:
            await pool.shutdown()

    text = run(scenario())
    assert "REFUTED" in text
    assert "Counterexample:" in text
    assert "only retry" in text


def test_the_worker_stays_warm_between_calls() -> None:
    """The reason the pool exists: paying sympy's import once, not per call."""
    pool = MathWorkerPool(size=1, timeout=40.0)

    async def scenario() -> tuple[float, float]:
        try:
            first = time.monotonic()
            await pool.submit("ping", {})
            cold = time.monotonic() - first

            second = time.monotonic()
            await pool.submit(
                "verify",
                {"kind": "identity", "claim": {"lhs": "sin(x)**2", "rhs": "1 - cos(x)**2"}},
            )
            warm = time.monotonic() - second
            return cold, warm
        finally:
            await pool.shutdown()

    cold, warm = run(scenario())
    assert warm < max(cold, 0.5), f"second call took {warm:.2f}s after a {cold:.2f}s start"


def test_a_runaway_calculation_is_killed_and_the_pool_recovers() -> None:
    """A pathological simplify does not check for interrupts — hence a process."""
    pool = MathWorkerPool(size=1, timeout=40.0)

    async def scenario() -> str:
        try:
            with pytest.raises(MathWorkerError):
                await pool.submit("eval", {"code": "n = 0\nwhile True:\n    n += 1"}, timeout=3.0)
            # The pool must be usable again; a killed worker costs one restart,
            # not the rest of the session.
            result = await pool.submit(
                "verify",
                {
                    "kind": "linalg",
                    "claim": {
                        "task": "determinant",
                        "matrix": [["1", "2"], ["3", "4"]],
                        "value": "-2",
                    },
                },
            )
            return str(result["status"])
        finally:
            await pool.shutdown()

    assert run(scenario()) == "verified"


def test_concurrent_jobs_do_not_cross_on_the_pipe() -> None:
    """Chats stream in parallel, so two verifications can land at once."""
    pool = MathWorkerPool(size=2, timeout=40.0)

    async def scenario() -> list[str]:
        try:
            results = await asyncio.gather(
                pool.submit(
                    "verify",
                    {"kind": "identity", "claim": {"lhs": "exp(x)*exp(y)", "rhs": "exp(x+y)"}},
                ),
                pool.submit(
                    "verify",
                    {"kind": "derivative",
                     "claim": {"function": "sin(x)", "variable": "x", "derivative": "cos(x)"}},
                ),
            )
            return [str(r["status"]) for r in results]
        finally:
            await pool.shutdown()

    assert run(scenario()) == ["verified", "verified"]


def test_the_eval_sandbox_refuses_imports_in_a_real_worker() -> None:
    pool = MathWorkerPool(size=1, timeout=40.0)

    async def scenario() -> dict[str, object]:
        try:
            return await pool.submit("eval", {"code": "import os\nos.getcwd()"})
        finally:
            await pool.shutdown()

    result = run(scenario())
    message = str(result["error"])
    # Naming the rule is not enough. A live 2.6B model, told only that imports
    # are refused, rewrote the import and called again — twice. The message has
    # to carry the fix: the modules are already there.
    assert "ALREADY available" in message
    assert "sympy" in message


def test_a_plot_renders_through_the_worker() -> None:
    pool = MathWorkerPool(size=1, timeout=40.0)

    async def scenario() -> dict[str, object]:
        try:
            return await pool.submit(
                "plot", {"kind": "cartesian", "exprs": ["exp(-x**2)"], "ranges": {"x": [-3, 3]}}
            )
        finally:
            await pool.shutdown()

    result = run(scenario())
    assert str(result["svg"]).startswith("<svg")
