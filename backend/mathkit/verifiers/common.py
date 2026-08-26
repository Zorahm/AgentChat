"""The job a verifier receives and the outcomes it may return.

Note what a :class:`VerifyJob` does **not** carry: the solution. The verifier
gets the problem and the final claim, and nothing else, so independence is a
property of the data structure rather than a promise in a prompt. The moment a
`solution` field appears here, the whole contour degrades into the model
agreeing with itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from schemas.math import (
    DEFAULT_SEED,
    NumericCheck,
    SymbolicCheck,
    VerifyOutcome,
)

from mathkit.numeric import NumericVerdict


@dataclass(frozen=True)
class VerifyJob:
    """One claim to check, exactly as it crossed the process boundary."""

    kind: str
    problem: str
    claim: dict[str, Any]
    domain: dict[str, Any] | None = None
    seed: int = DEFAULT_SEED

    def text(self, *names: str, default: str = "") -> str:
        """First present, non-empty value among *names*.

        Models spell the same field several ways across turns (``function`` /
        ``expr`` / ``f``). Accepting the synonyms costs one tuple and saves an
        ``error`` badge that says nothing about the mathematics.
        """
        for name in names:
            value = self.claim.get(name)
            if isinstance(value, (str, int, float)) and str(value).strip():
                return str(value).strip()
        return default

    def items(self, *names: str) -> list[Any]:
        """First present list-valued field among *names*, normalised to a list."""
        for name in names:
            value = self.claim.get(name)
            if isinstance(value, list):
                return value
            if isinstance(value, (str, int, float)) and str(value).strip():
                return [value]
        return []


def _numeric(verdict: NumericVerdict | None) -> NumericCheck | None:
    if verdict is None or verdict.samples == 0:
        return None
    return NumericCheck(
        ok=verdict.ok,
        max_abs_err=verdict.max_abs_err,
        max_rel_err=verdict.max_rel_err,
        samples=verdict.samples,
        detail=verdict.detail,
    )


def outcome(
    job: VerifyJob,
    status: str,
    *,
    method: str,
    detail: str,
    symbolic: SymbolicCheck | None = None,
    numeric: NumericVerdict | None = None,
    numeric_check: NumericCheck | None = None,
    counterexample: dict[str, Any] | None = None,
) -> VerifyOutcome:
    """Build the outcome, stamping the job's own fields back onto it.

    ``numeric`` is a sampled verdict; ``numeric_check`` is an already-formed
    report, for the checks whose numeric path is a single quadrature or a
    partial-sum walk rather than a sweep of points.
    """
    return VerifyOutcome(
        status=status,  # type: ignore[arg-type]
        kind=job.kind,  # type: ignore[arg-type]
        problem=job.problem,
        claim=job.claim,
        symbolic=symbolic,
        numeric=numeric_check if numeric_check is not None else _numeric(numeric),
        counterexample=counterexample,
        detail=detail,
        method=method,
        seed=job.seed,
    )


def combine(
    job: VerifyJob,
    *,
    method: str,
    symbolic_ok: bool | None,
    symbolic_detail: str,
    numeric: NumericVerdict | None,
    counterexample: dict[str, Any] | None = None,
    partial_reason: str = "",
) -> VerifyOutcome:
    """Fold a symbolic result and a numeric result into one status.

    The interesting case is disagreement. When ``simplify`` says zero and the
    sampler says otherwise (or the reverse), the answer is **not** verified —
    that pattern is what a lost branch of a complex root looks like, and both
    halves "agreeing with the answer" separately is exactly when it hides. Such
    a split lands as ``partial`` with the split named in the detail, never green.
    """
    numeric_ok = None if numeric is None or numeric.abstained else numeric.ok
    symbolic = (
        SymbolicCheck(ok=bool(symbolic_ok), detail=symbolic_detail)
        if symbolic_ok is not None
        else None
    )

    if symbolic_ok is False and numeric_ok is False:
        return outcome(
            job,
            "refuted",
            method=method,
            detail=symbolic_detail or "the claim does not satisfy the problem",
            symbolic=symbolic,
            numeric=numeric,
            counterexample=counterexample or (numeric.counterexample if numeric else None),
        )

    if symbolic_ok is True and numeric_ok is True:
        return outcome(
            job,
            "verified",
            method=method,
            detail=f"{symbolic_detail} Numerically confirmed on {numeric.samples} points."  # type: ignore[union-attr]
            if numeric
            else symbolic_detail,
            symbolic=symbolic,
            numeric=numeric,
        )

    if symbolic_ok is True and numeric_ok is None:
        return outcome(
            job,
            "verified" if not partial_reason else "partial",
            method=method,
            detail=(
                f"{symbolic_detail} {partial_reason}".strip()
                if partial_reason
                else f"{symbolic_detail} The numeric check abstained (no usable sample points)."
            ),
            symbolic=symbolic,
            numeric=numeric,
        )

    if symbolic_ok is None and numeric_ok is True:
        return outcome(
            job,
            "partial",
            method=method,
            detail=(
                "Symbolic simplification did not settle it, but the claim holds "
                f"numerically on {numeric.samples} points. "  # type: ignore[union-attr]
                "That is strong evidence, not a proof."
            ),
            numeric=numeric,
        )

    if numeric_ok is False:
        return outcome(
            job,
            "refuted",
            method=method,
            detail=(
                "The claim fails numerically — see the counterexample. "
                f"{symbolic_detail}".strip()
            ),
            symbolic=symbolic,
            numeric=numeric,
            counterexample=counterexample or (numeric.counterexample if numeric else None),
        )

    if symbolic_ok is False:
        return outcome(
            job,
            "refuted",
            method=method,
            detail=symbolic_detail,
            symbolic=symbolic,
            numeric=numeric,
            counterexample=counterexample,
        )

    return outcome(
        job,
        "inconclusive",
        method=method,
        detail="Neither the symbolic nor the numeric path could settle this claim.",
        symbolic=symbolic,
        numeric=numeric,
    )
