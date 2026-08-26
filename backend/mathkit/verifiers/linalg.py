"""Linear algebra: the one family where substitution is the whole check.

``A·x − b`` and ``A·v − λ·v`` are exact, cheap, and share nothing with the
elimination or the characteristic polynomial that produced the answer. There is
no reason to ever re-solve, and re-solving is what would let a bad pivot pass
twice.
"""

from __future__ import annotations

from typing import Any

import sympy

from mathkit.parsing import MathParseError, parse_math
from mathkit.verifiers.common import VerifyJob, outcome
from schemas.math import SymbolicCheck, VerifyOutcome

# Matrices past this are a paste accident, not a claim — and building one costs
# quadratic time in the parser before anything is checked.
MAX_DIMENSION = 60


def _matrix(raw: Any, what: str) -> sympy.Matrix:
    """Read a nested list (or a flat vector) of expression strings."""
    if isinstance(raw, str):
        parsed = parse_math(raw, what=what)
        if isinstance(parsed, sympy.MatrixBase):
            return sympy.Matrix(parsed)
        raise MathParseError(f"{what} is not a matrix")
    if not isinstance(raw, list) or not raw:
        raise MathParseError(f"{what} must be a non-empty list")

    rows = raw if isinstance(raw[0], list) else [[cell] for cell in raw]
    if len(rows) > MAX_DIMENSION or any(len(r) > MAX_DIMENSION for r in rows):
        raise MathParseError(f"{what} exceeds {MAX_DIMENSION}×{MAX_DIMENSION}")
    width = len(rows[0])
    if any(len(r) != width for r in rows):
        raise MathParseError(f"{what} has rows of differing length")

    return sympy.Matrix(
        [[parse_math(str(cell), what=f"{what} entry") for cell in row] for row in rows]
    )


def _residual_report(residual: sympy.Matrix) -> tuple[bool, float, dict[str, Any] | None]:
    """Is the residual vector zero, and if not, where is it worst?"""
    simplified = residual.applyfunc(sympy.simplify)
    worst = 0.0
    worst_at = 0
    for index, entry in enumerate(simplified):
        try:
            magnitude = abs(complex(sympy.N(entry, 25)))
        except (TypeError, ValueError):
            magnitude = float("inf")
        if magnitude > worst:
            worst, worst_at = magnitude, index
    if all(entry == 0 for entry in simplified):
        return True, 0.0, None
    if worst <= 1e-12:
        return True, worst, None
    return (
        False,
        worst,
        {"row": worst_at, "residual": str(simplified[worst_at]), "magnitude": f"{worst:.6g}"},
    )


def verify_linalg(job: VerifyJob) -> VerifyOutcome:
    """Dispatch on the claim's ``task`` and substitute."""
    task = job.text("task", "operation", "subkind", default="solve").lower()
    matrix = _matrix(job.claim.get("matrix") or job.claim.get("A"), "the matrix")

    if task in ("solve", "system", "linear_system"):
        return _verify_solve(job, matrix)
    if task in ("eigenvector", "eigen", "eigenpair"):
        return _verify_eigen(job, matrix)
    if task in ("inverse", "invert"):
        return _verify_inverse(job, matrix)
    if task in ("determinant", "det"):
        return _verify_determinant(job, matrix)
    raise MathParseError(
        f"unknown linalg task {task!r} — expected solve, eigenvector, inverse or determinant"
    )


def _verify_solve(job: VerifyJob, matrix: sympy.Matrix) -> VerifyOutcome:
    rhs = _matrix(job.claim.get("rhs") or job.claim.get("b"), "the right-hand side")
    solution = _matrix(
        job.claim.get("solution") or job.claim.get("x") or job.claim.get("value"),
        "the claimed solution",
    )
    if matrix.cols != solution.rows:
        raise MathParseError(
            f"A is {matrix.rows}×{matrix.cols} but x has {solution.rows} entries"
        )

    ok, worst, where = _residual_report(matrix * solution - rhs)
    if not ok:
        return outcome(
            job,
            "refuted",
            method="substituted the claimed solution: computed A·x − b",
            detail=f"A·x − b is not the zero vector — the worst entry is {worst:.3g}.",
            symbolic=SymbolicCheck(ok=False, detail="residual is non-zero"),
            counterexample=where,
        )

    # A solution that checks out may still be one of infinitely many. Saying
    # `verified` for "x is *the* solution" when the system is underdetermined
    # would be a different claim than the one checked.
    unique = matrix.rows >= matrix.cols and matrix.rank() == matrix.cols
    return outcome(
        job,
        "verified" if unique else "partial",
        method="substituted the claimed solution: computed A·x − b",
        detail=(
            "A·x equals b exactly, and the system has full column rank, so this is "
            "the unique solution."
            if unique
            else "A·x equals b exactly, but the system is rank-deficient — this is a "
            "valid solution, not the only one."
        ),
        symbolic=SymbolicCheck(ok=True, detail="A·x − b = 0"),
    )


def _verify_eigen(job: VerifyJob, matrix: sympy.Matrix) -> VerifyOutcome:
    vector = _matrix(
        job.claim.get("vector") or job.claim.get("eigenvector") or job.claim.get("v"),
        "the claimed eigenvector",
    )
    eigenvalue = parse_math(
        job.text("eigenvalue", "lambda", "value"), what="the claimed eigenvalue"
    )
    if vector.is_zero_matrix:
        return outcome(
            job,
            "refuted",
            method="computed A·v − λ·v",
            detail="the zero vector is not an eigenvector by definition.",
            symbolic=SymbolicCheck(ok=False, detail="v = 0"),
            counterexample={"vector": "0"},
        )

    ok, worst, where = _residual_report(matrix * vector - eigenvalue * vector)
    return outcome(
        job,
        "verified" if ok else "refuted",
        method="computed A·v − λ·v directly",
        detail=(
            "A·v equals λ·v exactly — the pair is a genuine eigenpair."
            if ok
            else f"A·v − λ·v is not zero; the worst entry is {worst:.3g}."
        ),
        symbolic=SymbolicCheck(ok=ok, detail="A·v − λ·v = 0" if ok else "residual is non-zero"),
        counterexample=where,
    )


def _verify_inverse(job: VerifyJob, matrix: sympy.Matrix) -> VerifyOutcome:
    inverse = _matrix(
        job.claim.get("inverse") or job.claim.get("solution") or job.claim.get("value"),
        "the claimed inverse",
    )
    if matrix.rows != matrix.cols:
        raise MathParseError("only a square matrix has an inverse")

    left_ok, left_worst, where = _residual_report(matrix * inverse - sympy.eye(matrix.rows))
    right_ok, right_worst, right_where = _residual_report(
        inverse * matrix - sympy.eye(matrix.rows)
    )
    ok = left_ok and right_ok
    return outcome(
        job,
        "verified" if ok else "refuted",
        method="multiplied both ways: A·A⁻¹ and A⁻¹·A against the identity",
        detail=(
            "Both products equal the identity exactly."
            if ok
            else f"the products differ from I by up to {max(left_worst, right_worst):.3g}."
        ),
        symbolic=SymbolicCheck(ok=ok, detail="A·A⁻¹ = A⁻¹·A = I" if ok else "product is not I"),
        counterexample=where or right_where,
    )


def _verify_determinant(job: VerifyJob, matrix: sympy.Matrix) -> VerifyOutcome:
    claimed = parse_math(job.text("value", "determinant", "det"), what="the claimed determinant")
    if matrix.rows != matrix.cols:
        raise MathParseError("only a square matrix has a determinant")

    # Two independent routes: Bareiss (exact, fraction-free) and LU. Agreement
    # between them is what rules out an arithmetic slip inside SymPy itself.
    bareiss = sympy.simplify(matrix.det(method="bareiss") - claimed)
    try:
        lu = sympy.simplify(matrix.det(method="lu") - claimed)
    except Exception:  # noqa: BLE001 — LU fails on singular symbolic matrices
        lu = bareiss

    ok = bareiss == 0 and lu == 0
    return outcome(
        job,
        "verified" if ok else "refuted",
        method="computed the determinant twice, by Bareiss and by LU",
        detail=(
            "Both methods return the claimed value."
            if ok
            else f"the determinant is {sympy.simplify(matrix.det())}, not the claimed value."
        ),
        symbolic=SymbolicCheck(ok=ok, detail="det(A) − claim = 0" if ok else "values differ"),
        counterexample=None if ok else {"determinant": str(sympy.simplify(matrix.det()))},
    )
