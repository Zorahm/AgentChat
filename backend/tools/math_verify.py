"""math_verify — check a final answer against the problem it answers.

This tool is in the **base** tool set, not just the maths preset, because a
machine-checked answer is worth having in any chat that produces one. What
differs between the two is the trigger: the base prompt asks for it on a final
numeric or symbolic claim, and the `math` skill makes it mandatory and routine.

Three properties are enforced here rather than requested in the prompt, because
a prompt-level rule is one the model can talk itself out of:

* **The verifier never sees the solution.** Only ``problem`` and ``claim`` cross
  into the worker. There is no field for reasoning, so there is nothing to
  agree with.
* **A refuted claim earns exactly one rewrite.** The second refutation stops,
  and both attempts stay visible. Without the cap a wrong answer becomes an
  unbounded loop; without keeping the first attempt the badge becomes theatre.
* **An ``error`` never triggers a rewrite.** A worker timeout says nothing about
  the answer, and rewriting a correct solution because SymPy was slow is the
  worst outcome this contour can produce.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from mathkit.progress import VerifyProgressEmitter
from mathkit.runner import MathWorkerError, MathWorkerPool
from schemas.math import DEFAULT_SEED, VerifyOutcome
from tools.base import BaseTool, ToolDefinition, ToolSchema

# §10.2: one automatic rewrite per claim, never two. Keyed per claim rather than
# per message, because one answer legitimately carries several claims.
MAX_ATTEMPTS_PER_CLAIM = 2
# Backstop against a model that keeps inventing fresh "problems" to get around
# the per-claim cap.
MAX_CALLS_PER_TURN = 8

_KINDS = (
    "root",
    "identity",
    "derivative",
    "integral_indef",
    "integral_def",
    "limit",
    "sum",
    "linalg",
    "probability",
    "combinatorics",
    "inequality",
    "proof",
    "other",
)

# One table, two consumers: the tool description the model reads up front, and
# the error it gets back when its `claim` was prose. Kept together so the shape
# it is told about and the shape it is corrected towards can never disagree.
_SHAPE_BY_KIND: dict[str, str] = {
    "root": "{equation, variable, roots:[...]}",
    "identity": "{lhs, rhs}",
    "derivative": "{function, variable, derivative, order?}",
    "integral_indef": "{integrand, variable, antiderivative}",
    "integral_def": "{integrand, variable, lower, upper, value}",
    "limit": "{expression, variable, point, value, direction?}",
    "sum": "{term, index, lower, upper, value}",
    "linalg": (
        "{task:'solve'|'eigenvector'|'inverse'|'determinant', matrix, rhs?, "
        "solution?/vector?/eigenvalue?/value?}"
    ),
    "probability": (
        "{value, trial} — trial is a Python expression running ONE trial with "
        "`rng`/`randint`/`choice` and evaluating True on success"
    ),
    "combinatorics": (
        "{value, space, predicate} — space is a Python expression yielding every "
        "candidate, predicate an expression in `x`"
    ),
    "inequality": "{statement} or {lhs, relation, rhs}",
    "proof": "{statement} — returns inconclusive; proofs are not machine-checkable",
    "other": "no fixed shape — pick the kind that matches what you actually assert",
}

_EXAMPLE_BY_KIND: dict[str, str] = {
    "root": '{"equation": "x**2 - 5*x + 6 = 0", "variable": "x", "roots": ["2", "3"]}',
    "identity": '{"lhs": "sin(x)**2 + cos(x)**2", "rhs": "1"}',
    "derivative": '{"function": "x**3", "variable": "x", "derivative": "3*x**2"}',
    "integral_indef": '{"integrand": "x*exp(x)", "variable": "x", "antiderivative": "(x-1)*exp(x)"}',
    "integral_def": (
        '{"integrand": "x**2", "variable": "x", "lower": "0", "upper": "1", "value": "1/3"}'
    ),
    "limit": '{"expression": "sin(x)/x", "variable": "x", "point": "0", "value": "1"}',
    "sum": '{"term": "1/n**2", "index": "n", "lower": "1", "upper": "oo", "value": "pi**2/6"}',
    "linalg": (
        '{"task": "solve", "matrix": [["2","1"],["1","3"]], "rhs": ["5","10"], '
        '"solution": ["1","3"]}'
    ),
    "probability": '{"value": "1/6", "trial": "randint(1,6) + randint(1,6) == 7"}',
    "combinatorics": (
        '{"value": "252", "space": "itertools.combinations(range(10), 5)", '
        '"predicate": "True"}'
    ),
    "inequality": '{"statement": "x**2 + 1 > 0"}',
    "proof": '{"statement": "sqrt(2) is irrational"}',
    "other": (
        'pick a real kind instead — e.g. kind="root" with '
        '{"equation": "x**2 - 4 = 0", "variable": "x", "roots": ["2", "-2"]}'
    ),
}

_CLAIM_SHAPES = " · ".join(
    f"{kind}: {shape}" for kind, shape in _SHAPE_BY_KIND.items() if kind not in ("proof", "other")
)


class MathVerifyTool(BaseTool):
    """Independently check a final mathematical claim."""

    name = "math_verify"
    description = (
        "Independently check a FINAL mathematical answer by substituting it back "
        "into the problem — roots into the equation, an antiderivative through "
        "differentiation, a probability against a Monte Carlo simulation. Call it "
        "once your answer is settled, not on intermediate steps. It never sees "
        "your reasoning, only the problem and the claim, so it can genuinely "
        "disagree with you. Returns verified / refuted / partial / inconclusive / "
        "error — treat `error` as 'the check failed', NOT as 'the answer is wrong'. "
        "On `refuted` you get a counterexample: fix the solution and verify once "
        "more (one retry only). The result is shown to the user as a badge."
    )
    # Signals agent.loop to run execute() as a task and forward progress_queue
    # events as tool_progress while it runs.
    streams_progress = True

    def __init__(
        self,
        pool: MathWorkerPool,
        *,
        store: Any = None,
        chat_id: str = "",
        message_id: str = "",
    ) -> None:
        self._pool = pool
        self._store = store
        self._chat_id = chat_id
        self._message_id = message_id
        # Per-request state: the tool instance lives exactly one user turn, which
        # is the scope the attempt cap is defined over.
        self._attempts: dict[str, int] = {}
        self._calls = 0
        self.progress_queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

    def set_context(self, store: Any, *, chat_id: str, message_id: str) -> None:
        """Attach the history store and the ids of the turn being verified.

        Stamped per request the way the filesystem tools take their sandbox
        policy: the factory builds the tool without knowing which chat it is
        for, and ``api.chat`` knows the message id only after it has minted one.
        """
        self._store = store
        self._chat_id = chat_id
        self._message_id = message_id

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            function=ToolSchema(
                name=self.name,
                description=self.description,
                parameters={
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": list(_KINDS),
                            "description": (
                                "What sort of claim this is. Pick the one that matches "
                                "what you actually assert. Use 'other' (or 'proof') when "
                                "none fits — that returns 'inconclusive' honestly instead "
                                "of checking the wrong thing."
                            ),
                        },
                        "problem": {
                            "type": "string",
                            "description": (
                                "The original problem, restated exactly, in LaTeX or SymPy "
                                "notation. The claim is checked against THIS, so any drift "
                                "from the user's actual question silently verifies the "
                                "wrong problem. It is shown to the user next to the badge."
                            ),
                        },
                        "claim": {
                            "type": "object",
                            "description": (
                                "The final answer, structured by kind — " + _CLAIM_SHAPES
                            ),
                        },
                        "domain": {
                            "type": "object",
                            "description": (
                                'Optional constraints, e.g. {"vars": {"x": {"min": 0, '
                                '"max": 10}}}. Sampling and inequality checks use it.'
                            ),
                        },
                        "seed": {
                            "type": "integer",
                            "description": (
                                f"Seed for the numeric checks. Leave unset ({DEFAULT_SEED}) "
                                "so the same answer always gets the same verdict."
                            ),
                        },
                    },
                    "required": ["kind", "problem", "claim"],
                },
            )
        )

    async def execute(  # type: ignore[override]
        self,
        kind: str = "other",
        problem: str = "",
        claim: dict[str, Any] | str | None = None,
        domain: dict[str, Any] | str | None = None,
        seed: int = DEFAULT_SEED,
    ) -> str:
        """Run one check and report it. Never raises into the agent loop."""
        emit = VerifyProgressEmitter(self.progress_queue)
        try:
            return await self._run(emit, kind, problem, claim, domain, seed)
        except Exception as exc:  # noqa: BLE001 — a tool must never break the turn
            # Named type, because a message-less exception (NotImplementedError
            # stringifies to "") otherwise produces a dangling "failed — ".
            detail = f"{type(exc).__name__}: {exc}".rstrip(": ")
            emit.failed(detail)
            return f"Error: math_verify failed — {detail}"
        finally:
            emit.done()

    async def _run(
        self,
        emit: VerifyProgressEmitter,
        kind: str,
        problem: str,
        claim: dict[str, Any] | str | None,
        domain: dict[str, Any] | str | None,
        seed: int,
    ) -> str:
        if kind not in _KINDS:
            return f"Error: unknown kind {kind!r}. Expected one of: {', '.join(_KINDS)}."

        parsed_claim = _as_dict(claim)
        if not parsed_claim:
            # Naming the failure is not enough — a model handed "see the schema"
            # sends the same prose claim again. Observed twice in a row on a
            # small model. So the error carries the exact shape for the kind it
            # was actually given, and a filled-in example it can copy.
            return (
                f"Error: `claim` must be a JSON object, not prose. For kind "
                f"{kind!r} it needs: {_SHAPE_BY_KIND.get(kind, _SHAPE_BY_KIND['other'])}\n"
                f"Example: {_EXAMPLE_BY_KIND.get(kind, _EXAMPLE_BY_KIND['other'])}\n"
                "Put the mathematics in the fields; don't describe it in a sentence."
            )

        self._calls += 1
        if self._calls > MAX_CALLS_PER_TURN:
            return (
                f"Error: math_verify has already run {MAX_CALLS_PER_TURN} times this "
                "turn. Stop verifying and give the user your answer with the results "
                "you already have."
            )

        signature = _signature(kind, problem, parsed_claim)
        attempt = self._attempts.get(signature, 0) + 1
        if attempt > MAX_ATTEMPTS_PER_CLAIM:
            return (
                "This claim has already been checked twice and was refuted both "
                "times. Do not verify it again. Tell the user plainly that you could "
                "not solve the problem, and show both counterexamples."
            )
        self._attempts[signature] = attempt

        emit.start(kind, problem, attempt, self._message_id)
        try:
            raw = await self._pool.submit(
                "verify",
                {
                    "kind": kind,
                    "problem": problem,
                    "claim": parsed_claim,
                    "domain": _as_dict(domain) or None,
                    "seed": int(seed) if isinstance(seed, (int, float)) else DEFAULT_SEED,
                },
            )
        except MathWorkerError as exc:
            emit.failed(str(exc))
            return (
                f"Error: the verifier could not run — {exc}. This says NOTHING about "
                "whether your answer is right. Do not rewrite a solution because of "
                "it; carry on and tell the user the check was unavailable."
            )

        outcome = VerifyOutcome.model_validate({**raw, "attempt": attempt})
        emit.verdict(outcome.model_dump(mode="json"))
        self._persist(outcome)
        return _report(outcome, attempt)

    def _persist(self, outcome: VerifyOutcome) -> None:
        """Record it in the history table. Best-effort: the badge already has the
        result, so a store failure must not turn a good check into an error."""
        if self._store is None or not self._message_id:
            return
        try:
            self._store.record(
                chat_id=self._chat_id, message_id=self._message_id, outcome=outcome
            )
        except Exception:  # noqa: BLE001 — history is not worth losing a turn over
            pass


def _as_dict(value: dict[str, Any] | str | None) -> dict[str, Any]:
    """Accept an object, or the JSON string some providers send instead."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _signature(kind: str, problem: str, claim: dict[str, Any]) -> str:
    """Identify "the same claim" across a rewrite.

    Keyed on the *problem*, not the claim: the second attempt is by definition a
    different answer to the same question, and keying on the answer would hand
    every rewrite a fresh pair of attempts.
    """
    return f"{kind}::{' '.join(problem.split()).lower()[:400]}"


def _report(outcome: VerifyOutcome, attempt: int) -> str:
    """What the model reads back — verdict, evidence, and what to do next."""
    lines = [f"Verification: {outcome.status.upper()} ({outcome.kind}, attempt {attempt})"]
    if outcome.method:
        lines.append(f"Method: {outcome.method}")
    lines.append(outcome.detail)

    if outcome.symbolic is not None:
        lines.append(
            f"Symbolic: {'ok' if outcome.symbolic.ok else 'failed'} — {outcome.symbolic.detail}"
        )
    if outcome.numeric is not None:
        lines.append(
            f"Numeric: {'ok' if outcome.numeric.ok else 'failed'} — "
            f"{outcome.numeric.samples} samples, worst relative error "
            f"{outcome.numeric.max_rel_err:.3e}. {outcome.numeric.detail}"
        )
    if outcome.counterexample:
        lines.append(f"Counterexample: {json.dumps(outcome.counterexample, ensure_ascii=False)}")

    lines.append("")
    lines.append(_next_step(outcome.status, attempt))
    return "\n".join(lines)


def _next_step(status: str, attempt: int) -> str:
    if status == "verified":
        return (
            "The user can see this badge. Say briefly in your answer what was checked "
            "and how — don't just assert that it is verified."
        )
    if status == "refuted":
        if attempt >= MAX_ATTEMPTS_PER_CLAIM:
            return (
                "Second refutation — stop here. Do NOT verify again. Tell the user "
                "directly that you could not solve this correctly, and show both "
                "counterexamples so they can see where it broke."
            )
        return (
            "Your answer is wrong. Work out where the counterexample breaks your "
            "method, redo the solution, and call math_verify once more. This is your "
            "only retry."
        )
    if status == "partial":
        return (
            "Partly checked. Say in your answer exactly which part is confirmed and "
            "which is not — do not present this as fully verified."
        )
    if status == "inconclusive":
        return (
            "Nothing here is machine-checkable. Do not claim the answer was verified. "
            "If a check is genuinely wanted, the user can press Re-check to run the "
            "independent verifier agent."
        )
    return (
        "The check itself failed. This is not evidence about your answer — do not "
        "rewrite a correct solution because of it."
    )
