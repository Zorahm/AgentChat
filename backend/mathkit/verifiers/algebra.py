"""Roots, identities and inequalities.

Every check here is a *substitution*, never a re-derivation. The verifier never
solves the equation to compare answers — it puts the claimed answer back into
the problem and looks at what is left. A re-derivation reproduces whatever
method the model used, including its mistake; a substitution cannot.

Completeness is tracked separately from correctness, because they fail
differently: roots that all substitute cleanly while a fourth root is missing is
a *wrong answer to the question asked*, and reporting it green because "every
number you named is a root" is precisely the failure this contour exists to
catch.
"""

from __future__ import annotations

from typing import Any

import sympy

from mathkit.numeric import DEFAULT_RANGE, check_vanishes, sample_points, var_range
from mathkit.parsing import (
    MathParseError,
    free_symbols_of,
    parse_math,
    parse_relation,
    parse_symbol,
)
from mathkit.verifiers.common import VerifyJob, combine, outcome
from schemas.math import SymbolicCheck, VerifyOutcome

# Solving to establish completeness is a convenience, not the check. Past this
# many seconds it is abandoned and the outcome degrades to `partial` — the
# claim's own substitution has already been done by then.
_SOLVE_TIMEOUT_TERMS = 400


def _term_scale(expr: sympy.Expr) -> sympy.Expr:
    """Magnitude to judge a residual against: the size of the terms involved.

    ``|x**2| + |5*x| + |6|`` rather than a bare 1. At a genuine root the terms
    are large and cancel, so a relative miss is measured against the
    cancellation that had to happen — which is what "this root is wrong by a
    little" actually means.
    """
    try:
        terms = expr.as_ordered_terms()
    except Exception:  # noqa: BLE001 — non-Add expressions have no term list
        terms = [expr]
    if len(terms) > _SOLVE_TIMEOUT_TERMS:
        return sympy.Abs(expr)
    return sympy.Add(*[sympy.Abs(t) for t in terms]) if terms else sympy.Integer(1)


def _is_zero(expr: sympy.Expr) -> bool | None:
    """``True``/``False`` when simplification settles it, ``None`` when it doesn't.

    The float rule is load-bearing. A model answering "the root is 0.7390851332"
    is right, and substituting that back leaves a residual of about 1e-17 — not
    an exact zero, so exact symbolic comparison says **False** and the verifier
    refutes a correct answer. Any residual carrying a floating-point literal is
    an approximation by construction, so exactness is the wrong question to ask
    of it: abstain, and let the relative-error check decide. A genuinely wrong
    decimal root still fails there, and still lands as `refuted`.
    """
    try:
        simplified = sympy.simplify(expr)
    except Exception:  # noqa: BLE001 — simplify raises on exotic input
        return None
    if simplified == 0:
        return True
    if simplified.has(sympy.Float):
        return None
    try:
        value = simplified.is_zero
    except Exception:  # noqa: BLE001
        return None
    return value


def _infer_variable(job: VerifyJob, expr: sympy.Expr, *names: str) -> sympy.Symbol:
    """The claim's variable, or the only free symbol if the claim omitted it."""
    stated = job.text(*names)
    if stated:
        return parse_symbol(stated)
    symbols = free_symbols_of(expr)
    if len(symbols) == 1:
        return symbols[0]
    return parse_symbol("", default="x")


def verify_root(job: VerifyJob) -> VerifyOutcome:
    """Substitute each claimed root, then ask separately whether the set is complete."""
    source = job.text("equation", "expression", "expr")
    if not source:
        # Deliberately NOT falling back to `job.problem`. That field is prose by
        # contract — the problem "restated exactly", shown to the user to audit —
        # and feeding it to the parser once turned "Solve the quadratic equation
        # x^2-5x+6=0" into a product of symbols called Solve, the, quadratic and
        # equation. The correct roots then failed to substitute, and a right
        # answer came back `refuted`. Missing field is an error, not a verdict.
        raise MathParseError(
            "the claim has no `equation` field — put the equation there in SymPy "
            "or LaTeX notation, e.g. {\"equation\": \"x**2 - 5*x + 6 = 0\"}"
        )
    lhs, rhs = parse_relation(source)
    residual = sympy.together(lhs - rhs)
    variable = _infer_variable(job, residual, "variable", "var")

    claimed = job.items("roots", "solutions", "values", "root")
    if not claimed:
        raise MathParseError("claim carries no roots to substitute")

    roots: list[sympy.Expr] = [parse_math(str(r), what="root") for r in claimed]
    scale = _term_scale(residual)

    failures: list[dict[str, Any]] = []
    symbolic_all = True
    for original, root in zip(claimed, roots):
        substituted = residual.subs(variable, root)
        verdict = _is_zero(substituted)
        numeric = check_vanishes(
            substituted,
            scale.subs(variable, root),
            free_symbols_of(substituted),
            job.domain,
            seed=job.seed,
        )
        if verdict is False or (verdict is None and not numeric.ok and not numeric.abstained):
            failures.append(
                {
                    "root": str(original),
                    "residual": str(sympy.nsimplify(sympy.N(substituted, 12), rational=False)),
                }
            )
        if verdict is not True:
            symbolic_all = False

    if failures:
        return outcome(
            job,
            "refuted",
            method=f"substituted each claimed root for {variable.name} in the original equation",
            detail=(
                f"{len(failures)} of {len(roots)} claimed roots do not satisfy the "
                "equation — the residual is not zero."
            ),
            symbolic=SymbolicCheck(ok=False, detail="substitution left a non-zero residual"),
            counterexample={"failing_roots": failures},
        )

    missing = _missing_roots(lhs, rhs, variable, roots)
    method = "substituted every claimed root back into the original equation"

    if missing is None:
        return outcome(
            job,
            "partial",
            method=method,
            detail=(
                "Every claimed root satisfies the equation. Completeness of the set "
                "could not be established — the equation is not one this solver can "
                "close, so there may be further roots."
            ),
            symbolic=SymbolicCheck(ok=True, detail="all substitutions vanish"),
        )

    if missing:
        return outcome(
            job,
            "refuted",
            method=method,
            detail=(
                "Every claimed root is genuine, but the set is incomplete — the "
                f"equation has {len(missing)} further root(s) the answer omits."
            ),
            symbolic=SymbolicCheck(ok=False, detail="root set is not complete"),
            counterexample={"missing_roots": [str(m) for m in missing]},
        )

    return outcome(
        job,
        "verified",
        method=method,
        detail=(
            f"All {len(roots)} claimed roots substitute to zero, and the solution "
            "set is complete — no other roots exist."
        ),
        symbolic=SymbolicCheck(ok=True, detail="substitution vanishes; solution set matches"),
    )


def _missing_roots(
    lhs: sympy.Expr, rhs: sympy.Expr, variable: sympy.Symbol, claimed: list[sympy.Expr]
) -> list[sympy.Expr] | None:
    """Roots the solver finds that the claim omits. ``None`` = solver abstained.

    ``None`` is the honest answer for transcendental equations and is what makes
    the difference between a `partial` badge and a false green one.
    """
    try:
        found = sympy.solve(sympy.Eq(lhs, rhs), variable, dict=False)
    except Exception:  # noqa: BLE001 — solve raises on most things it can't do
        return None
    if not isinstance(found, list) or not found:
        return None

    missing: list[sympy.Expr] = []
    for root in found:
        if not isinstance(root, sympy.Expr) or root.free_symbols:
            return None  # a parametric family — set comparison is meaningless
        if not any(_same_number(root, c) for c in claimed):
            missing.append(root)
    return missing


def _same_number(left: sympy.Expr, right: sympy.Expr) -> bool:
    """Do these two constants denote the same number?

    Symbolic first, numeric as the fallback — because ``sqrt(2)`` and
    ``1.4142135623730951`` are the same root written two ways, and an exact
    comparison says otherwise. Without this the solver's exact roots look like
    roots the answer *omitted*, and a correct decimal answer is refuted for
    being incomplete.
    """
    verdict = _is_zero(sympy.simplify(left - right))
    if verdict is not None:
        return verdict
    try:
        difference = abs(complex(sympy.N(left - right, 25)))
        scale = max(
            abs(complex(sympy.N(left, 25))), abs(complex(sympy.N(right, 25))), 1.0
        )
    except (TypeError, ValueError):
        return False
    return difference / scale <= 1e-9


def verify_identity(job: VerifyJob) -> VerifyOutcome:
    """``A ≡ B``: simplify the difference *and* sample it. Both, always."""
    left_text = job.text("lhs", "left", "a")
    right_text = job.text("rhs", "right", "b")
    if left_text and right_text:
        lhs, rhs = parse_math(left_text, what="lhs"), parse_math(right_text, what="rhs")
    else:
        # Same rule as verify_root: `problem` is prose and never parsed.
        statement = job.text("identity", "statement", "expression")
        if not statement:
            raise MathParseError(
                "the claim has no `lhs`/`rhs` (or `statement`) — put the two sides "
                'there, e.g. {"lhs": "sin(x)**2 + cos(x)**2", "rhs": "1"}'
            )
        lhs, rhs = parse_relation(statement)

    difference = sympy.together(lhs - rhs)
    scale = sympy.Abs(lhs) + sympy.Abs(rhs)
    symbols = free_symbols_of(lhs, rhs)
    symbolic_ok = _is_zero(difference)
    numeric = check_vanishes(difference, scale, symbols, job.domain, seed=job.seed)

    return combine(
        job,
        method="simplified A − B to zero and sampled it across the domain",
        symbolic_ok=symbolic_ok,
        symbolic_detail=(
            "simplify(A − B) collapses to 0."
            if symbolic_ok
            else "simplify(A − B) did not reach 0."
        ),
        numeric=numeric,
    )


_RELATIONS = {
    ">": sympy.StrictGreaterThan,
    ">=": sympy.GreaterThan,
    "<": sympy.StrictLessThan,
    "<=": sympy.LessThan,
}


def verify_inequality(job: VerifyJob) -> VerifyOutcome:
    """Sample the region, then check its boundary and interior critical points.

    Sampling alone is the wrong tool: a smooth inequality fails on a set of
    measure zero far more often than it fails on a random point, so the extremes
    are tested explicitly rather than hoped for.
    """
    statement = job.text("statement", "inequality", "expression")
    relation_text = job.text("relation", "op", "operator")
    if not statement and relation_text not in _RELATIONS:
        # Same rule as verify_root: `problem` is prose and never parsed.
        raise MathParseError(
            "the claim has no `statement` (or `lhs`/`relation`/`rhs`) — put the "
            'inequality there, e.g. {"statement": "x**2 + 1 > 0"}'
        )

    if relation_text in _RELATIONS:
        lhs = parse_math(job.text("lhs", "left", "expression"), what="lhs")
        rhs = parse_math(job.text("rhs", "right", default="0"), what="rhs")
        relation = _RELATIONS[relation_text](lhs, rhs)
    else:
        relation = _parse_inequality(statement)
        lhs, rhs = relation.lhs, relation.rhs

    margin = sympy.together(lhs - rhs)
    symbols = free_symbols_of(lhs, rhs)
    strict = isinstance(relation, (sympy.StrictGreaterThan, sympy.StrictLessThan))
    wants_positive = isinstance(relation, (sympy.GreaterThan, sympy.StrictGreaterThan))

    violation = _first_violation(margin, symbols, job, wants_positive, strict)
    if violation is not None:
        return outcome(
            job,
            "refuted",
            method="sampled the region and tested its boundary and critical points",
            detail="the inequality fails at a point inside the stated domain",
            symbolic=SymbolicCheck(ok=False, detail="a counterexample exists"),
            counterexample=violation,
        )

    holds, symbolic_detail, outside = _solution_set_covers(relation, symbols, job.domain)
    if holds is False and outside is not None:
        return outcome(
            job,
            "refuted",
            method="solved the inequality and compared its solution set with the stated domain",
            detail=(
                "The inequality does not hold on all of the stated domain — the "
                "solution set leaves part of it out. Sampling missed it, which is "
                "what a failure on a set of measure zero looks like."
            ),
            symbolic=SymbolicCheck(ok=False, detail=symbolic_detail),
            counterexample=outside,
        )

    if holds is True:
        return outcome(
            job,
            "verified",
            method="solved the inequality and checked its solution set covers the domain",
            detail=f"The inequality holds on the whole domain — {symbolic_detail}",
            symbolic=SymbolicCheck(ok=True, detail=symbolic_detail),
        )

    return outcome(
        job,
        "partial",
        method="sampled the region and tested its boundary and critical points",
        detail=(
            "No counterexample was found at any sampled point, on the boundary, or "
            "at an interior critical point. That is evidence, not a proof — the "
            f"inequality was not established symbolically ({symbolic_detail})."
        ),
    )


def _solution_set_covers(
    relation: Any, symbols: list[sympy.Symbol], domain: dict[str, Any] | None
) -> tuple[bool | None, str, dict[str, Any] | None]:
    """Does the inequality's solution set contain the whole domain?

    This is the only path here that *proves* anything. Sampling can refute, and
    can build confidence, but "no counterexample among 160 points" is not a
    theorem — and reporting it as one is how the badge stops meaning anything.
    """
    try:
        settled = sympy.simplify(relation)
    except Exception:  # noqa: BLE001
        settled = None
    if settled is sympy.true:
        return True, "the relation simplifies to a tautology", None
    if settled is sympy.false:
        return False, "the relation simplifies to a contradiction", {"detail": "never true"}

    if len(symbols) != 1:
        return None, "no single-variable solution set to compare", None

    variable = symbols[0]
    if domain and (domain.get("vars") or {}).get(variable.name):
        low, high = var_range(domain, variable.name)
        region: Any = sympy.Interval(sympy.Float(low), sympy.Float(high))
    else:
        region = sympy.S.Reals

    try:
        solution = sympy.solve_univariate_inequality(
            relation, variable, relational=False, domain=sympy.S.Reals
        )
    except Exception:  # noqa: BLE001 — solve_univariate_inequality is fragile by nature
        return None, "the inequality could not be solved symbolically", None

    try:
        if region.is_subset(solution):
            return True, f"its solution set {solution} contains the domain", None
        excluded = sympy.Complement(region, solution)
    except Exception:  # noqa: BLE001
        return None, "the solution set could not be compared with the domain", None

    return False, f"the solution set is {solution}", _witness(excluded, variable)


def _witness(excluded: Any, variable: sympy.Symbol) -> dict[str, Any] | None:
    """One concrete point of the excluded set, for the counterexample."""
    try:
        if excluded.is_empty:
            return None
        for candidate in (getattr(excluded, "inf", None), getattr(excluded, "sup", None)):
            if candidate is None or candidate.has(sympy.oo, -sympy.oo):
                continue
            return {variable.name: str(candidate), "excluded": str(excluded)}
        return {"excluded": str(excluded)}
    except Exception:  # noqa: BLE001
        return None


def _parse_inequality(text: str) -> Any:
    for token in ("<=", ">=", "<", ">"):
        if token in text:
            left, _, right = text.partition(token)
            return _RELATIONS[token](
                parse_math(left, what="lhs"), parse_math(right, what="rhs")
            )
    raise MathParseError(f"{text!r} does not contain an inequality sign")


def _first_violation(
    margin: sympy.Expr,
    symbols: list[sympy.Symbol],
    job: VerifyJob,
    wants_positive: bool,
    strict: bool,
) -> dict[str, Any] | None:
    """Random points, then domain endpoints, then stationary points."""
    candidates = list(sample_points(symbols, job.domain, seed=job.seed, count=160))
    if len(symbols) == 1:
        low, high = var_range(job.domain, symbols[0].name) if job.domain else DEFAULT_RANGE
        edge = [complex(low, 0), complex(high, 0), complex((low + high) / 2, 0)]
        candidates += [{symbols[0].name: value} for value in edge]
        try:
            stationary = sympy.solve(sympy.diff(margin, symbols[0]), symbols[0], dict=False)
        except Exception:  # noqa: BLE001
            stationary = []
        for point in stationary if isinstance(stationary, list) else []:
            if isinstance(point, sympy.Expr) and not point.free_symbols:
                try:
                    value = complex(sympy.N(point))
                except (TypeError, ValueError):
                    continue
                if low <= value.real <= high and abs(value.imag) < 1e-12:
                    candidates.append({symbols[0].name: value})

    for point in candidates:
        try:
            value = complex(sympy.N(margin.subs({sympy.Symbol(k): v.real for k, v in point.items()}), 20))
        except Exception:  # noqa: BLE001 — a pole is not a counterexample
            continue
        if abs(value.imag) > 1e-9:
            continue
        real = value.real
        fails = real < -1e-12 if wants_positive else real > 1e-12
        if not fails and strict and abs(real) <= 1e-12:
            fails = True
        if fails:
            return {**{k: f"{v.real:.6g}" for k, v in point.items()}, "margin": f"{real:.6g}"}
    return None
