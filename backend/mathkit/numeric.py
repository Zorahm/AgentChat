"""The numeric half of every check: sampling, tolerance and confidence.

Two rules here decide whether the badge means anything.

**Tolerance is relative.** An absolute threshold passes everything that lives
near zero and fails everything large, so the same wrong answer is `verified` at
one scale and `refuted` at another. Every comparison below is a residual
divided by the magnitude of what it is a residual *of*.

**Sampling is seeded and ordered.** The draw for each variable is derived from
one seed plus the variable's position in a sorted list. Without that, the same
answer comes back `verified` on one run and `partial` on the next, and a badge
that flickers is a badge nobody reads.
"""

from __future__ import annotations

import cmath
import random
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Sequence

import sympy

# Relative error a symbolic-quality answer must beat. Loose enough to survive
# double-precision cancellation in a long expression, tight enough that a wrong
# coefficient cannot hide.
REL_TOL = 1e-9
# When the true value is essentially zero there is no relative scale left, so
# the residual is judged against this instead.
ABS_FLOOR = 1e-12

DEFAULT_SAMPLES = 96
# Below this many usable points the domain is mostly singular and the numeric
# path abstains rather than voting on a handful of accidents.
MIN_USABLE_SAMPLES = 8

DEFAULT_RANGE = (-4.0, 4.0)


@dataclass(frozen=True)
class NumericVerdict:
    """Outcome of one sampled comparison.

    ``ok is False`` with a ``counterexample`` is a real disagreement.
    ``abstained`` is the third state, and it has to be its own field rather than
    "few samples": a single 30-digit quadrature or an accelerated series sum is
    one data point and a complete check, while eight points scattered across a
    pole-ridden domain are many data points and no check at all. Deriving one
    from the other labelled every exact evaluation an abstention.
    """

    ok: bool
    max_abs_err: float = 0.0
    max_rel_err: float = 0.0
    samples: int = 0
    counterexample: dict[str, str] | None = None
    detail: str = ""
    abstained: bool = False


def var_range(domain: dict[str, Any] | None, name: str) -> tuple[float, float]:
    """Per-variable sampling window from the caller's ``domain``, else the default."""
    if not domain:
        return DEFAULT_RANGE
    spec = (domain.get("vars") or {}).get(name)
    if not isinstance(spec, dict):
        return DEFAULT_RANGE
    try:
        low = float(spec.get("min", DEFAULT_RANGE[0]))
        high = float(spec.get("max", DEFAULT_RANGE[1]))
    except (TypeError, ValueError):
        return DEFAULT_RANGE
    return (low, high) if low < high else DEFAULT_RANGE


def sample_points(
    symbols: Sequence[sympy.Symbol],
    domain: dict[str, Any] | None,
    *,
    seed: int,
    count: int = DEFAULT_SAMPLES,
    complex_points: bool = False,
) -> list[dict[str, complex]]:
    """Draw *count* substitution maps, reproducibly.

    Irrational offsets on purpose: sampling on integers or halves lands exactly
    on the poles, branch points and periods that a wrong answer is most likely
    to agree with the right one at.
    """
    if not symbols:
        return [{}]
    points: list[dict[str, complex]] = []
    for index in range(count):
        rng = random.Random((seed << 20) ^ (index << 8))
        point: dict[str, complex] = {}
        for position, sym in enumerate(symbols):
            low, high = var_range(domain, sym.name)
            jitter = rng.random()
            value = low + (high - low) * jitter
            # Push off the exact endpoints and off any integer we happened to hit.
            value += 1e-3 * (position + 1) * (1 if jitter < 0.5 else -1)
            if complex_points:
                point[sym.name] = complex(value, low + (high - low) * rng.random())
            else:
                point[sym.name] = complex(value, 0.0)
        points.append(point)
    return points


def _compile(expr: sympy.Expr, symbols: Sequence[sympy.Symbol]) -> Callable[..., Any]:
    """Compile *expr* for fast repeated evaluation, with an exact fallback.

    ``lambdify`` fails on constructs it has no printer for (unevaluated
    integrals, exotic special functions). Falling back to ``evalf`` keeps those
    checkable — slower, but a slow check beats an ``error``.
    """
    try:
        fn = sympy.lambdify(list(symbols), expr, modules=["mpmath"])
    except Exception:  # noqa: BLE001 — lambdify raises many unrelated types
        def fn(*args: Any) -> Any:
            subs = {sym: sympy.nsimplify(val) for sym, val in zip(symbols, args)}
            return complex(sympy.N(expr.subs(subs), 20))

    return fn


def _as_complex(value: Any) -> complex | None:
    """Coerce whatever mpmath/sympy handed back into a finite complex, or None."""
    try:
        out = complex(value)
    except (TypeError, ValueError, OverflowError, ZeroDivisionError):
        return None
    if not (cmath.isfinite(out.real) and cmath.isfinite(out.imag)):
        return None
    return out


def check_vanishes(
    residual: sympy.Expr,
    scale: sympy.Expr,
    symbols: Sequence[sympy.Symbol],
    domain: dict[str, Any] | None = None,
    *,
    seed: int,
    samples: int = DEFAULT_SAMPLES,
) -> NumericVerdict:
    """Sample ``residual / scale`` and report the worst relative miss.

    *scale* is the magnitude the residual should be judged against — typically
    ``|lhs| + |rhs|``. Passing a constant 1 turns this back into an absolute
    check, which is exactly what it must not be.
    """
    if not symbols:
        # A closed-form claim: one evaluation is the whole numeric check.
        residual_value = _as_complex(sympy.N(residual, 30))
        scale_value = _as_complex(sympy.N(scale, 30))
        if residual_value is None:
            return NumericVerdict(ok=False, detail="value is not finite")
        magnitude = abs(scale_value) if scale_value is not None else 1.0
        rel = abs(residual_value) / max(magnitude, ABS_FLOOR)
        ok = rel <= REL_TOL or abs(residual_value) <= ABS_FLOOR
        return NumericVerdict(
            ok=ok,
            max_abs_err=abs(residual_value),
            max_rel_err=rel,
            samples=1,
            counterexample=None if ok else {"value": str(sympy.N(residual, 12))},
            detail="evaluated the closed form to 30 digits",
        )

    for complex_points in (False, True):
        residual_fn = _compile(residual, symbols)
        scale_fn = _compile(scale, symbols)
        worst_abs = 0.0
        worst_rel = 0.0
        used = 0
        counterexample: dict[str, str] | None = None
        for point in sample_points(
            symbols, domain, seed=seed, count=samples, complex_points=complex_points
        ):
            args = [point[s.name] for s in symbols]
            try:
                residual_value = _as_complex(residual_fn(*args))
                scale_value = _as_complex(scale_fn(*args))
            except Exception:  # noqa: BLE001 — a pole, a branch cut, a domain error
                continue
            if residual_value is None:
                continue
            used += 1
            magnitude = abs(scale_value) if scale_value is not None else 1.0
            rel = abs(residual_value) / max(magnitude, ABS_FLOOR)
            if abs(residual_value) > worst_abs:
                worst_abs = abs(residual_value)
            if rel > worst_rel:
                worst_rel = rel
                if rel > REL_TOL and abs(residual_value) > ABS_FLOOR:
                    counterexample = {
                        **{s.name: _fmt(point[s.name]) for s in symbols},
                        "residual": _fmt(residual_value),
                    }

        if used >= MIN_USABLE_SAMPLES:
            ok = worst_rel <= REL_TOL or worst_abs <= ABS_FLOOR
            return NumericVerdict(
                ok=ok,
                max_abs_err=worst_abs,
                max_rel_err=worst_rel,
                samples=used,
                counterexample=None if ok else counterexample,
                detail=(
                    f"sampled {used} {'complex' if complex_points else 'real'} points"
                ),
            )

    return NumericVerdict(
        ok=False,
        samples=0,
        abstained=True,
        detail="too few points where the expression is finite — numeric check abstained",
    )


def _fmt(value: complex) -> str:
    """Short, readable form of a sample coordinate for a counterexample."""
    if abs(value.imag) < 1e-15:
        return f"{value.real:.6g}"
    return f"{value.real:.6g}{value.imag:+.6g}i"


# ── Monte Carlo ───────────────────────────────────────────────────────────

# 4 sigma. Wide on purpose: this interval only ever *refutes*, and a correct
# probability refuted by sampling noise is the single worst failure this whole
# contour can produce.
CI_SIGMA = 4.0


def wilson_interval(successes: int, trials: int, sigma: float = CI_SIGMA) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion.

    Not the normal approximation: near p=0 or p=1 that one produces intervals
    reaching outside [0,1] and refutes correct answers to certainties.
    """
    if trials <= 0:
        return (0.0, 1.0)
    phat = successes / trials
    z2 = sigma * sigma
    denominator = 1.0 + z2 / trials
    centre = (phat + z2 / (2 * trials)) / denominator
    spread = (
        sigma
        * ((phat * (1 - phat) / trials + z2 / (4 * trials * trials)) ** 0.5)
        / denominator
    )
    return (max(0.0, centre - spread), min(1.0, centre + spread))


def count_matching(items: Iterable[Any], predicate: Callable[[Any], Any], limit: int) -> int:
    """Count items satisfying *predicate*, refusing to walk an unbounded space.

    The limit is what keeps a combinatorial claim from turning the check into
    the harder problem: a space too large to enumerate is an abstention, not a
    verification and not a hang.
    """
    total = 0
    seen = 0
    for item in items:
        seen += 1
        if seen > limit:
            raise ValueError(f"enumeration exceeded {limit} candidates")
        if predicate(item):
            total += 1
    return total
