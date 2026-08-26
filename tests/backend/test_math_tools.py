"""The three math tools, and the rules they enforce rather than request.

The attempt cap and the error/refuted distinction are enforced in code here
because a prompt-level rule is one a model under pressure talks itself out of.
Both are pinned below: two attempts per claim and no more, and a worker failure
that never reads as "your answer is wrong".
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from mathkit.runner import MathWorkerError  # noqa: E402
from schemas.math import VerifyOutcome  # noqa: E402
from tools.math_eval import MathEvalTool  # noqa: E402
from tools.math_plot import MathPlotTool  # noqa: E402
from tools.math_verify import (  # noqa: E402
    MAX_ATTEMPTS_PER_CLAIM,
    MAX_CALLS_PER_TURN,
    MathVerifyTool,
)


class FakePool:
    """Stands in for the worker pool: canned answers, recorded calls."""

    def __init__(self, results: list[Any] | None = None) -> None:
        self.results = results or []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def submit(self, op: str, payload: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        self.calls.append((op, payload))
        result = self.results.pop(0) if self.results else {}
        if isinstance(result, Exception):
            raise result
        return result


def outcome(status: str, **over: Any) -> dict[str, Any]:
    base = VerifyOutcome(
        status=status,  # type: ignore[arg-type]
        kind="root",
        problem="x^2 - 5x + 6 = 0",
        claim={"roots": ["2", "3"]},
        detail=f"{status} detail",
        method="substitution",
        counterexample={"root": "4"} if status == "refuted" else None,
    )
    return {**base.model_dump(mode="json"), **over}


def drain(tool: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while not tool.progress_queue.empty():
        events.append(tool.progress_queue.get_nowait())
    return events


CLAIM = {"equation": "x**2 - 5*x + 6 = 0", "variable": "x", "roots": ["2", "3"]}


# ── math_verify ───────────────────────────────────────────────────────────


def test_verdict_is_streamed_as_a_progress_event() -> None:
    """The badge needs the structure; the model gets a sentence. Two channels."""
    pool = FakePool([outcome("verified")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="root", problem="x^2-5x+6=0", claim=CLAIM))

    assert "VERIFIED" in text
    kinds = [e["kind"] for e in drain(tool)]
    assert kinds == ["start", "verdict", "done"]


def test_the_verifier_is_never_handed_the_solution() -> None:
    """Independence is structural: there is no field for reasoning to arrive in."""
    pool = FakePool([outcome("verified")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    asyncio.run(tool.execute(kind="root", problem="x^2-5x+6=0", claim=CLAIM))

    _, payload = pool.calls[0]
    assert set(payload) == {"kind", "problem", "claim", "domain", "seed"}


def test_one_rewrite_per_claim_and_no_more() -> None:
    """§10.2: refuted twice is a stop, not a third round."""
    pool = FakePool([outcome("refuted"), outcome("refuted")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    first = asyncio.run(tool.execute(kind="root", problem="x^2-5x+6=0", claim=CLAIM))
    assert "only retry" in first

    second = asyncio.run(tool.execute(kind="root", problem="x^2-5x+6=0", claim={"roots": ["9"]}))
    assert "Second refutation" in second

    third = asyncio.run(tool.execute(kind="root", problem="x^2-5x+6=0", claim={"roots": ["7"]}))
    assert "already been checked twice" in third
    # The third call never reached the worker.
    assert len(pool.calls) == MAX_ATTEMPTS_PER_CLAIM


def test_attempts_are_counted_per_claim_not_per_message() -> None:
    """One answer can carry several claims; a shared counter would starve them."""
    pool = FakePool([outcome("refuted"), outcome("refuted"), outcome("verified")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    asyncio.run(tool.execute(kind="root", problem="first problem", claim=CLAIM))
    asyncio.run(tool.execute(kind="root", problem="second problem", claim=CLAIM))
    text = asyncio.run(tool.execute(kind="identity", problem="third problem", claim=CLAIM))

    assert "VERIFIED" in text
    assert len(pool.calls) == 3


def test_a_worker_failure_is_never_a_refutation() -> None:
    """Antipattern 4. Rewriting a correct solution over a timeout is the worst
    outcome the design can produce, so the tool says so in as many words."""
    pool = FakePool([MathWorkerError("the calculation exceeded its 25s budget")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="root", problem="x^2-5x+6=0", claim=CLAIM))

    assert "Error:" in text
    assert "NOTHING about" in text
    assert "Do not rewrite" in text
    assert [e["kind"] for e in drain(tool)] == ["start", "failed", "done"]


def test_error_status_does_not_earn_a_retry() -> None:
    """An `error` outcome consumes an attempt but must not invite a rewrite."""
    pool = FakePool([outcome("error")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="root", problem="p", claim=CLAIM))
    assert "not evidence about your answer" in text


def test_inconclusive_says_it_established_nothing() -> None:
    pool = FakePool([outcome("inconclusive")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="proof", problem="p", claim={"statement": "x"}))
    assert "Do not claim the answer was verified" in text


def test_a_runaway_turn_is_capped() -> None:
    pool = FakePool([outcome("verified") for _ in range(MAX_CALLS_PER_TURN + 2)])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    for index in range(MAX_CALLS_PER_TURN):
        asyncio.run(tool.execute(kind="root", problem=f"problem {index}", claim=CLAIM))
    text = asyncio.run(tool.execute(kind="root", problem="one too many", claim=CLAIM))
    assert "Stop verifying" in text


def test_claim_sent_as_a_json_string_is_accepted() -> None:
    """Some providers serialise object arguments; refusing them would surface as
    an `error` badge that says nothing about the mathematics."""
    pool = FakePool([outcome("verified")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="root", problem="p", claim='{"roots": ["2"]}'))
    assert "VERIFIED" in text


def test_a_prose_claim_is_corrected_with_the_shape_for_its_kind() -> None:
    """Observed on a live small model: handed "see the tool schema", it sent the
    same sentence again. So the error carries the exact fields for the kind it
    was actually given, plus a filled-in example it can copy."""
    tool = MathVerifyTool(FakePool())  # type: ignore[arg-type]

    text = asyncio.run(
        tool.execute(kind="root", problem="p", claim="The roots are x = 2 and x = 3.")
    )
    assert text.startswith("Error:")
    assert "{equation, variable, roots:[...]}" in text
    assert '"roots": ["2", "3"]' in text


def test_an_other_kind_claim_is_pointed_at_a_real_kind() -> None:
    tool = MathVerifyTool(FakePool())  # type: ignore[arg-type]
    text = asyncio.run(tool.execute(kind="other", problem="p", claim="prose"))
    assert "pick a real kind" in text


def test_a_missing_claim_is_a_plain_error() -> None:
    tool = MathVerifyTool(FakePool())  # type: ignore[arg-type]
    text = asyncio.run(tool.execute(kind="root", problem="p", claim=None))
    assert text.startswith("Error:")


def test_outcomes_are_written_to_the_history_store() -> None:
    recorded: list[VerifyOutcome] = []

    class Store:
        def record(self, *, chat_id: str, message_id: str, outcome: VerifyOutcome) -> int:
            recorded.append(outcome)
            return 1

    pool = FakePool([outcome("verified")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]
    tool.set_context(Store(), chat_id="c1", message_id="m1")

    asyncio.run(tool.execute(kind="root", problem="p", claim=CLAIM))
    assert len(recorded) == 1 and recorded[0].status == "verified"


def test_a_broken_history_store_does_not_break_the_check() -> None:
    class Store:
        def record(self, **_: Any) -> int:
            raise RuntimeError("disk full")

    pool = FakePool([outcome("verified")])
    tool = MathVerifyTool(pool)  # type: ignore[arg-type]
    tool.set_context(Store(), chat_id="c1", message_id="m1")

    assert "VERIFIED" in asyncio.run(tool.execute(kind="root", problem="p", claim=CLAIM))


# ── math_eval ─────────────────────────────────────────────────────────────


def test_eval_reports_stdout_and_the_last_expression() -> None:
    pool = FakePool([{"stdout": "hi\n", "result": "30", "error": None}])
    tool = MathEvalTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(code="print('hi')\n30"))
    assert "hi" in text and "=> 30" in text


def test_eval_surfaces_the_sandbox_refusal_verbatim() -> None:
    pool = FakePool([{"stdout": "", "result": None, "error": "code uses a construct this sandbox refuses"}])
    tool = MathEvalTool(pool)  # type: ignore[arg-type]

    assert "sandbox refuses" in asyncio.run(tool.execute(code="import os"))


def test_eval_needs_code() -> None:
    tool = MathEvalTool(FakePool())  # type: ignore[arg-type]
    assert asyncio.run(tool.execute(code="  ")).startswith("Error:")


# ── math_plot ─────────────────────────────────────────────────────────────


def test_plot_streams_the_svg_rather_than_returning_it() -> None:
    """The markup would cost the model thousands of tokens it cannot use."""
    pool = FakePool([{"svg": "<svg/>", "title": "sin", "warnings": [], "series": 1}])
    tool = MathPlotTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="cartesian", exprs=["sin(x)"]))

    assert "<svg" not in text
    # A live run had the model answer with `![Parabola graph](graph)` — a broken
    # image, because the plot is its own card and there is no file to link to.
    assert "markdown image link" in text
    events = drain(tool)
    assert [e["kind"] for e in events] == ["start", "svg", "done"]
    assert events[1]["svg"] == "<svg/>"


def test_plot_rejects_an_unknown_kind_before_reaching_the_worker() -> None:
    pool = FakePool()
    tool = MathPlotTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="hologram", exprs=["x"]))
    assert text.startswith("Error:") and not pool.calls


def test_plot_needs_at_least_one_expression() -> None:
    tool = MathPlotTool(FakePool())  # type: ignore[arg-type]
    assert asyncio.run(tool.execute(kind="cartesian", exprs=[])).startswith("Error:")


def test_plot_failure_is_reported_as_failed_not_as_a_picture() -> None:
    pool = FakePool([{"error": "nothing was drawable"}])
    tool = MathPlotTool(pool)  # type: ignore[arg-type]

    text = asyncio.run(tool.execute(kind="cartesian", exprs=["log(x)"], ranges={"x": [-9, -2]}))
    assert text.startswith("Error:")
    assert [e["kind"] for e in drain(tool)] == ["start", "failed", "done"]


@pytest.mark.parametrize("tool_cls", [MathEvalTool, MathPlotTool])
def test_tools_declare_a_usable_schema(tool_cls: Any) -> None:
    definition = tool_cls(FakePool()).get_definition()
    assert definition.function.name.startswith("math_")
    assert definition.function.parameters["required"]
