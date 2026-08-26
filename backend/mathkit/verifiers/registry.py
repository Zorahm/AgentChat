"""kind → strategy, and what happens when there is no strategy.

The two "missing" cases are different and must stay different:

* a kind we deliberately don't automate (``proof``, ``other``) → ``inconclusive``,
  which is an honest verdict and the doorway to the subagent;
* a claim we couldn't read (bad field, unparseable expression) → ``error``,
  which says nothing whatsoever about the answer.

Collapsing the second into ``refuted`` is the failure that makes an agent
rewrite a correct solution because SymPy timed out.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from schemas.math import UNCHECKABLE_KINDS, VerifyOutcome

from mathkit.parsing import MathParseError
from mathkit.verifiers import algebra, calculus, linalg, stochastic
from mathkit.verifiers.common import VerifyJob, outcome

Verifier = Callable[[VerifyJob], VerifyOutcome]

VERIFIERS: dict[str, Verifier] = {
    "root": algebra.verify_root,
    "identity": algebra.verify_identity,
    "inequality": algebra.verify_inequality,
    "derivative": calculus.verify_derivative,
    "integral_indef": calculus.verify_integral_indef,
    "integral_def": calculus.verify_integral_def,
    "limit": calculus.verify_limit,
    "sum": calculus.verify_sum,
    "linalg": linalg.verify_linalg,
    "probability": stochastic.verify_probability,
    "combinatorics": stochastic.verify_combinatorics,
}

CHECKABLE_KINDS: tuple[str, ...] = tuple(sorted(VERIFIERS))


def run_verification(payload: dict[str, Any]) -> dict[str, Any]:
    """Run one claim through its strategy and return a serialisable outcome.

    Never raises: this is the whole body of a worker request, and an exception
    escaping here would kill a process the parent is holding a lock on.
    """
    job = VerifyJob(
        kind=str(payload.get("kind") or "other"),
        problem=str(payload.get("problem") or ""),
        claim=payload.get("claim") if isinstance(payload.get("claim"), dict) else {},
        domain=payload.get("domain") if isinstance(payload.get("domain"), dict) else None,
        seed=int(payload.get("seed") or 42),
    )
    started = time.monotonic()

    if job.kind in UNCHECKABLE_KINDS or job.kind not in VERIFIERS:
        result = outcome(
            job,
            "inconclusive",
            method="no deterministic strategy applies",
            detail=(
                "A proof is not machine-checkable here."
                if job.kind == "proof"
                else f"There is no deterministic check for kind {job.kind!r}. "
                f"Checkable kinds are: {', '.join(CHECKABLE_KINDS)}."
            ),
        )
        return _finish(result, started)

    try:
        result = VERIFIERS[job.kind](job)
    except MathParseError as exc:
        result = outcome(
            job,
            "error",
            method="parsing the claim",
            detail=(
                f"{exc} — this is a problem with the claim as written, not evidence "
                "about the answer. Fix the claim's fields and call again."
            ),
        )
    except RecursionError:
        result = outcome(
            job,
            "error",
            method="symbolic simplification",
            detail="the expression is too deeply nested for the CAS to simplify.",
        )
    except Exception as exc:  # noqa: BLE001 — sympy raises anything, from anywhere
        result = outcome(
            job,
            "error",
            method="deterministic verification",
            detail=f"the verifier failed: {type(exc).__name__}: {exc}"[:400],
        )

    return _finish(result, started)


def _finish(result: VerifyOutcome, started: float) -> dict[str, Any]:
    """Stamp the duration and enforce the counterexample invariant.

    A ``refuted`` badge without a concrete point is unusable: the agent is told
    it is wrong and given nothing to look at, which is how the automatic rewrite
    turns into a guess.
    """
    elapsed = int((time.monotonic() - started) * 1000)
    payload = result.model_copy(update={"duration_ms": elapsed})
    if payload.status == "refuted" and not payload.counterexample:
        payload = payload.model_copy(
            update={"counterexample": {"detail": payload.detail[:300]}}
        )
    return payload.model_dump(mode="json")
