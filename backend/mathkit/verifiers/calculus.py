"""Derivatives, integrals, limits and series — checked backwards.

The direction matters more than the mathematics here. An antiderivative is
verified by *differentiating it*, not by integrating the integrand again: the
second path re-runs whatever technique produced the answer, so a substitution
error made once is made twice and the two agree. Differentiation is mechanical,
total, and has no relationship to how the integral was found.

Where no reverse operation exists — a definite integral's number, a limit — the
independent path is numeric: quadrature and a two-sided approach sequence, which
share no code with SymPy's symbolic machinery.
"""

from __future__ import annotations

import sympy

from mathkit.numeric import ABS_FLOOR, REL_TOL, NumericVerdict, check_vanishes
from mathkit.parsing import (
    MathParseError,
    free_symbols_of,
    parse_math,
    parse_symbol,
)
from mathkit.verifiers.algebra import _is_zero, _term_scale
from mathkit.verifiers.common import VerifyJob, combine, outcome
from schemas.math import NumericCheck, SymbolicCheck, VerifyOutcome


def _variable(job: VerifyJob, expr: sympy.Expr) -> sympy.Symbol:
    stated = job.text("variable", "var", "with_respect_to")
    if stated:
        return parse_symbol(stated)
    symbols = free_symbols_of(expr)
    return symbols[0] if len(symbols) == 1 else parse_symbol("", default="x")


def verify_derivative(job: VerifyJob) -> VerifyOutcome:
    """``f′ = g``: differentiate f with the CAS, then sample the difference."""
    function = parse_math(
        job.text("function", "f", "expression", "expr"), what="the function"
    )
    claimed = parse_math(
        job.text("derivative", "result", "value", "g"), what="the claimed derivative"
    )
    variable = _variable(job, function)
    order = max(1, int(job.claim.get("order", 1) or 1))

    truth = sympy.diff(function, variable, order)
    difference = sympy.together(truth - claimed)
    scale = sympy.Abs(truth) + sympy.Abs(claimed)
    symbolic_ok = _is_zero(difference)
    numeric = check_vanishes(
        difference, scale, free_symbols_of(truth, claimed), job.domain, seed=job.seed
    )

    return combine(
        job,
        method=f"differentiated the function {order}× with respect to {variable.name} and compared",
        symbolic_ok=symbolic_ok,
        symbolic_detail=(
            "the CAS derivative and the claim differ by an expression that simplifies to 0."
            if symbolic_ok
            else f"the CAS derivative is {sympy.simplify(truth)}, which does not match the claim."
        ),
        numeric=numeric,
    )


def verify_integral_indef(job: VerifyJob) -> VerifyOutcome:
    """``∫f = F + C``: differentiate F and check it returns f. The reverse path."""
    integrand = parse_math(
        job.text("integrand", "f", "expression", "expr"), what="the integrand"
    )
    antiderivative = parse_math(
        job.text("antiderivative", "result", "value", "F"), what="the antiderivative"
    )
    variable = _variable(job, integrand)

    derivative = sympy.diff(antiderivative, variable)
    difference = sympy.together(derivative - integrand)
    scale = sympy.Abs(derivative) + sympy.Abs(integrand)
    symbolic_ok = _is_zero(difference)
    numeric = check_vanishes(
        difference, scale, free_symbols_of(derivative, integrand), job.domain, seed=job.seed
    )

    return combine(
        job,
        method="differentiated the claimed antiderivative and compared it to the integrand",
        symbolic_ok=symbolic_ok,
        symbolic_detail=(
            "d/d{v} of the claimed antiderivative simplifies to the integrand.".replace(
                "{v}", variable.name
            )
            if symbolic_ok
            else "differentiating the claimed antiderivative does not return the integrand."
        ),
        numeric=numeric,
    )


def verify_integral_def(job: VerifyJob) -> VerifyOutcome:
    """``∫ₐᵇ f = c``: numeric quadrature against the claimed number.

    Quadrature is the independent path — it never touches the antiderivative, so
    it cannot inherit an error made while finding one.
    """
    integrand = parse_math(job.text("integrand", "f", "expression", "expr"), what="the integrand")
    variable = _variable(job, integrand)
    lower = parse_math(job.text("lower", "a", "from", default="0"), what="the lower limit")
    upper = parse_math(job.text("upper", "b", "to", default="1"), what="the upper limit")
    claimed = parse_math(job.text("value", "result", "integral"), what="the claimed value")

    quadrature, quad_detail, trusted = _quadrature(integrand, variable, lower, upper)
    symbolic_ok, symbolic_detail = _symbolic_definite(integrand, variable, lower, upper, claimed)

    if quadrature is None or not trusted:
        # The numeric path abstains. When the CAS has already produced a closed
        # form equal to the claim, that is a proof and stands on its own — so no
        # `partial_reason` there, which would demote a proven answer to `partial`
        # for the sin of the *other* method being unavailable.
        return combine(
            job,
            method="attempted numeric quadrature and a symbolic antiderivative",
            symbolic_ok=symbolic_ok,
            symbolic_detail=(
                f"{symbolic_detail} The numeric check abstained: {quad_detail}."
            ),
            numeric=None,
            partial_reason=(
                "" if symbolic_ok is True else f"Quadrature could not be evaluated ({quad_detail})."
            ),
        )

    try:
        claimed_value = complex(sympy.N(claimed, 25))
    except (TypeError, ValueError) as exc:
        raise MathParseError(f"the claimed value is not numeric: {exc}") from exc

    error = abs(quadrature - claimed_value)
    relative = error / max(abs(quadrature), ABS_FLOOR)
    # Quadrature carries its own truncation error, so the bar is looser than the
    # symbolic tolerance — but still relative.
    numeric_ok = relative <= 1e-7 or error <= 1e-10
    numeric = NumericCheck(
        ok=numeric_ok,
        max_abs_err=error,
        max_rel_err=relative,
        samples=1,
        detail=quad_detail,
    )

    if symbolic_ok is True and numeric_ok:
        status, detail = "verified", (
            "The symbolic antiderivative and independent numeric quadrature both "
            "agree with the claimed value."
        )
    elif numeric_ok and symbolic_ok is None:
        status, detail = "partial", (
            f"Quadrature agrees with the claim to {relative:.2e} relative error. "
            "No symbolic antiderivative was available to confirm it exactly."
        )
    elif symbolic_ok is True:
        # The CAS closed form IS the claim, and only the quadrature dissents.
        # That is a disagreement between two methods, not a refutation: on a hard
        # improper or oscillatory integral the quadrature is the one that fails,
        # and a `refuted` here sends the agent off to rewrite a correct solution.
        status, detail = "partial", (
            f"The closed form matches the claim, but numeric integration returned "
            f"{quadrature.real:.12g} instead. On an improper or oscillatory "
            "integral that usually means the quadrature failed rather than the "
            "answer — the symbolic result is the stronger evidence here. "
            + symbolic_detail
        )
    elif not numeric_ok:
        status, detail = "refuted", (
            f"Numeric quadrature gives {quadrature.real:.12g}, the claim says "
            f"{claimed_value.real:.12g} — a relative error of {relative:.3e}."
        )
    else:
        status, detail = "partial", (
            "The symbolic and numeric paths disagree with each other, which usually "
            "means a branch or a singularity inside the interval. " + symbolic_detail
        )

    return outcome(
        job,
        status,
        method=f"integrated numerically over [{lower}, {upper}] and compared",
        detail=detail,
        symbolic=SymbolicCheck(ok=bool(symbolic_ok), detail=symbolic_detail)
        if symbolic_ok is not None
        else None,
        numeric_check=numeric,
        counterexample=(
            {"quadrature": f"{quadrature.real:.12g}", "claimed": f"{claimed_value.real:.12g}"}
            if status == "refuted"
            else None
        ),
    )


def _oscillation_zeros(integrand: sympy.Expr, variable: sympy.Symbol) -> Any:
    """A callable giving the k-th zero of the integrand's oscillation, or ``None``.

    ``quadosc`` needs to know where the sign changes are. For ``sin(φ(x))`` they
    sit at ``φ(x) = kπ``, so the k-th zero is ``φ⁻¹(kπ)`` — which SymPy can
    usually invert (``x³ = kπ`` → ``x = (kπ)^{1/3}``).
    """
    phase = None
    for node in integrand.atoms(sympy.sin, sympy.cos):
        argument = node.args[0]
        if argument.has(variable):
            phase = argument
            break
    if phase is None:
        return None

    index = sympy.Symbol("_k", positive=True)
    try:
        branches = sympy.solve(sympy.Eq(phase, index * sympy.pi), variable)
    except Exception:  # noqa: BLE001 — solve raises on most things it cannot invert
        return None

    for branch in branches if isinstance(branches, list) else []:
        if branch.free_symbols - {index}:
            continue
        try:
            candidate = sympy.lambdify(index, branch, modules=["mpmath"])
            first, second = complex(candidate(1)), complex(candidate(4))
        except Exception:  # noqa: BLE001
            continue
        # Real, positive and increasing — anything else is a complex branch of
        # the inverse, which would send quadosc off into the complex plane.
        if abs(first.imag) < 1e-12 and abs(second.imag) < 1e-12 and 0 < first.real < second.real:
            return candidate
    return None


def _quadrature(
    integrand: sympy.Expr, variable: sympy.Symbol, lower: sympy.Expr, upper: sympy.Expr
) -> tuple[complex | None, str, bool]:
    """Integrate numerically. Returns ``(value, detail, trusted)``.

    ``trusted`` is the load-bearing part. ``mpmath.quad`` does not merely
    struggle with an oscillatory integrand over an infinite interval — it
    returns a confident, plausible, wrong number: 1.18 for ∫₀^∞ sin(x³)/x, whose
    true value is π/6 ≈ 0.5236, and 1.70 for the textbook Dirichlet integral
    ∫₀^∞ sin(u)/u, whose true value is π/2 ≈ 1.5708. A verifier that believes
    those refutes correct answers, which is the costliest thing it can do.

    So an oscillatory improper integral goes to ``quadosc``, which handles it
    exactly; and if that cannot be set up, the numeric path **abstains** rather
    than voting with a number it has no reason to believe.
    """
    import mpmath

    def to_mp(value: sympy.Expr) -> Any:
        # ±∞ has to be handed to mpmath as its own infinity: `str(sympy.oo)` is
        # "oo", which mpmathify rejects, and an improper integral is exactly the
        # case where the independent numeric path is most worth having.
        if value.has(sympy.oo) and not value.has(-sympy.oo):
            return mpmath.inf
        if value.has(-sympy.oo):
            return -mpmath.inf
        return mpmath.mpmathify(str(sympy.N(value, 25)))

    infinite = lower.has(sympy.oo, -sympy.oo) or upper.has(sympy.oo, -sympy.oo)
    oscillatory = bool(integrand.atoms(sympy.sin, sympy.cos))

    try:
        fn = sympy.lambdify(variable, integrand, modules=["mpmath"])
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"[:160], False

    if infinite and oscillatory:
        zeros = _oscillation_zeros(integrand, variable)
        if zeros is None:
            return (
                None,
                "oscillatory over an infinite interval, and its zeros could not be "
                "located — plain quadrature is unreliable here and was not used",
                False,
            )
        try:
            with mpmath.workdps(30):
                value = mpmath.quadosc(fn, [to_mp(lower), to_mp(upper)], zeros=zeros)
            return complex(value), "oscillatory quadrature (quadosc) at 30 digits", True
        except Exception as exc:  # noqa: BLE001
            return None, f"quadosc failed — {type(exc).__name__}: {exc}"[:160], False

    try:
        with mpmath.workdps(30):
            value = mpmath.quad(fn, [to_mp(lower), to_mp(upper)])
    except Exception as exc:  # noqa: BLE001 — quadrature fails on many honest integrals
        return None, f"{type(exc).__name__}: {exc}"[:160], False
    return complex(value), "adaptive quadrature at 30 digits", True


def _symbolic_definite(
    integrand: sympy.Expr,
    variable: sympy.Symbol,
    lower: sympy.Expr,
    upper: sympy.Expr,
    claimed: sympy.Expr,
) -> tuple[bool | None, str]:
    try:
        exact = sympy.integrate(integrand, (variable, lower, upper))
    except Exception:  # noqa: BLE001
        return None, "SymPy could not produce a closed form."
    if exact.has(sympy.Integral):
        return None, "SymPy left the integral unevaluated."
    verdict = _is_zero(sympy.simplify(exact - claimed))
    if verdict is True:
        return True, f"the closed form {exact} matches the claim."
    if verdict is False:
        return False, f"the closed form is {exact}, which differs from the claim."
    return None, "the closed form could not be compared to the claim."


def verify_limit(job: VerifyJob) -> VerifyOutcome:
    """``lim = L``: the CAS limit, plus an approach sequence from both sides."""
    expression = parse_math(job.text("expression", "expr", "f"), what="the expression")
    variable = _variable(job, expression)
    point = parse_math(job.text("point", "at", "to", default="0"), what="the limit point")
    claimed = parse_math(job.text("value", "limit", "result"), what="the claimed limit")
    direction = job.text("direction", "side", default="both")

    sides = {"+": ["+"], "-": ["-"]}.get(direction, ["+", "-"])
    try:
        symbolic_values = [sympy.limit(expression, variable, point, side) for side in sides]
    except Exception:  # noqa: BLE001
        symbolic_values = []

    symbolic_ok: bool | None = None
    symbolic_detail = "SymPy could not evaluate the limit."
    if symbolic_values:
        agree = all(_is_zero(sympy.simplify(v - claimed)) for v in symbolic_values)
        differ = any(_is_zero(sympy.simplify(v - claimed)) is False for v in symbolic_values)
        if agree:
            symbolic_ok, symbolic_detail = True, "SymPy's limit matches the claim from every side."
        elif differ:
            symbolic_ok = False
            symbolic_detail = (
                f"SymPy's limit is {symbolic_values[0]}, which differs from the claim."
            )

    numeric, approach = _approach(expression, variable, point, claimed, sides)
    return combine(
        job,
        method=f"took the limit from {'both sides' if len(sides) > 1 else sides[0]} and walked a numeric approach sequence",
        symbolic_ok=symbolic_ok,
        symbolic_detail=symbolic_detail,
        numeric=numeric,
        counterexample=approach,
    )


def _approach(
    expression: sympy.Expr,
    variable: sympy.Symbol,
    point: sympy.Expr,
    claimed: sympy.Expr,
    sides: list[str],
) -> tuple[NumericVerdict | None, dict[str, str] | None]:
    """Evaluate along 10⁻¹…10⁻⁸ from each requested side."""
    try:
        target = complex(sympy.N(claimed, 25))
    except (TypeError, ValueError):
        return None, None
    if point.has(sympy.oo, -sympy.oo, sympy.zoo):
        offsets = [sympy.Integer(10) ** k for k in range(1, 9)]
        probes = [(("+", offset), offset) for offset in offsets]
    else:
        offsets = [sympy.Rational(1, 10**k) for k in range(1, 9)]
        probes = [((side, offset), offset) for side in sides for offset in offsets]

    used = 0
    # Seeded pessimistically: the verdict is read off the *tail* of the approach,
    # so an unreachable loop body must not read as convergence.
    last = 1.0
    trail: dict[str, str] = {}
    for (side, offset), _ in probes:
        probe = point + offset if side == "+" else point - offset
        if point.has(sympy.oo):
            probe = offset
        elif point.has(-sympy.oo):
            probe = -offset
        try:
            value = complex(sympy.N(expression.subs(variable, probe), 25))
        except Exception:  # noqa: BLE001
            continue
        used += 1
        last = abs(value - target) / max(abs(target), ABS_FLOOR)
        trail[f"{variable.name}{side}{offset}"] = f"{value.real:.10g}"

    if used < 8:
        return None, None
    ok = last <= 1e-5  # the tail is what converges, not the first probes
    return (
        NumericVerdict(
            ok=ok,
            max_abs_err=abs(last * max(abs(target), ABS_FLOOR)),
            max_rel_err=last,
            samples=used,
            detail=f"approached along {used} probes down to 10⁻⁸",
        ),
        None if ok else {"approach": trail},
    )


def verify_sum(job: VerifyJob) -> VerifyOutcome:
    """``Σ = S``: the closed form, plus partial sums evaluated independently."""
    term = parse_math(job.text("term", "summand", "expression", "expr"), what="the summand")
    index = parse_symbol(job.text("index", "variable", "var"), default="n")
    lower = parse_math(job.text("lower", "from", "start", default="1"), what="the lower index")
    upper_text = job.text("upper", "to", "end", default="oo")
    upper = parse_math(upper_text, what="the upper index")
    claimed = parse_math(job.text("value", "sum", "result"), what="the claimed sum")

    try:
        exact = sympy.summation(term, (index, lower, upper))
        symbolic_ok = None if exact.has(sympy.Sum) else _is_zero(sympy.simplify(exact - claimed))
        symbolic_detail = (
            "SymPy left the sum unevaluated."
            if exact.has(sympy.Sum)
            else f"SymPy's closed form is {exact}."
        )
    except Exception:  # noqa: BLE001
        symbolic_ok, symbolic_detail = None, "SymPy could not evaluate the sum."

    numeric = _partial_sums(term, index, lower, upper, claimed)
    return combine(
        job,
        method="evaluated the sum symbolically and accumulated partial sums numerically",
        symbolic_ok=symbolic_ok,
        symbolic_detail=symbolic_detail,
        numeric=numeric,
    )


def _partial_sums(
    term: sympy.Expr,
    index: sympy.Symbol,
    lower: sympy.Expr,
    upper: sympy.Expr,
    claimed: sympy.Expr,
) -> NumericVerdict | None:
    """Sum the series numerically, by a route that shares nothing with SymPy's.

    A finite sum is accumulated term by term. An infinite one goes through
    ``mpmath.nsum``, whose convergence acceleration is the whole point:
    truncating ∑1/n² at any practical N leaves a tail near 1/N, so a plain
    partial sum would refute the correct π²/6 for arithmetic reasons alone.
    """
    import mpmath

    try:
        target = complex(sympy.N(claimed, 25))
        start = int(sympy.N(lower))
    except (TypeError, ValueError):
        return None

    infinite = upper.has(sympy.oo)
    fn = sympy.lambdify(index, term, modules=["mpmath"])

    if infinite:
        try:
            with mpmath.workdps(30):
                total = complex(mpmath.nsum(fn, [start, mpmath.inf]))
        except Exception:  # noqa: BLE001 — a divergent or awkward series
            return None
        counted = 0
        detail = "summed to convergence with mpmath.nsum at 30 digits"
        tolerance = 1e-12
    else:
        try:
            stop = int(sympy.N(upper))
        except (TypeError, ValueError):
            return None
        if stop - start > 200_000:
            return None
        total = 0j
        counted = 0
        for k in range(start, stop + 1):
            try:
                total += complex(fn(k))
            except Exception:  # noqa: BLE001 — an undefined term ends the walk honestly
                break
            counted += 1
        if counted == 0:
            return None
        detail = f"summed {counted} terms directly"
        tolerance = REL_TOL

    error = abs(total - target)
    relative = error / max(abs(target), ABS_FLOOR)
    return NumericVerdict(
        ok=relative <= tolerance,
        max_abs_err=error,
        max_rel_err=relative,
        samples=max(counted, 1),
        detail=detail,
    )
