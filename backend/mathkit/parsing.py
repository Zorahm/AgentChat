"""Turn model-written expression strings into SymPy objects, safely.

``sympify`` is not usable here. It falls through to ``eval`` against the real
builtins, so a claim string is a code-execution primitive — and these strings
come from a model, over the wire, on behalf of whoever is chatting. Everything
below goes through :func:`parse_expr` with a *closed* namespace instead: the
only names that resolve are the ones in :data:`SAFE_NAMESPACE`, and attribute
access is refused outright before parsing starts.

The LaTeX pre-pass exists because models write claims the way they write
answers. ``\\frac{1}{2}`` is not a SymPy expression, and rejecting it would push
the model into rewriting its own answer by hand — the one step where a claim
silently stops matching the solution it came from. sympy's own ``parse_latex``
would cover more, but it needs the antlr4 runtime as a hard dependency; this
handles the constructs that actually show up and leaves the rest to SymPy
syntax.
"""

from __future__ import annotations

import re
from typing import Any

import sympy
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication,
    parse_expr,
    standard_transformations,
)

# Past this an expression is a mistake or an attack, never a claim.
MAX_EXPR_CHARS = 4000


class MathParseError(ValueError):
    """The input could not be read as mathematics. Always an ``error``, never a
    ``refuted`` — a claim we failed to parse says nothing about the answer."""


# Attribute access is the whole escape surface once the namespace is closed:
# `(1).__class__.__base__.__subclasses__()`. Refused textually, before parse.
_FORBIDDEN = re.compile(r"__|\blambda\b|\bimport\b|\bexec\b|\beval\b|\bopen\b|;")

# Names the parser is allowed to resolve. Anything else raises rather than
# becoming a free symbol, so a typo'd `sin` cannot silently parse as a variable
# and make an identity "hold".
_ALLOWED_FUNCS = (
    "sin cos tan cot sec csc asin acos atan acot atan2 "
    "sinh cosh tanh asinh acosh atanh "
    "exp log ln sqrt cbrt Abs sign floor ceiling "
    "factorial binomial gamma loggamma erf erfc beta zeta "
    "LambertW Ei Si Ci li polylog harmonic digamma polygamma "
    "uppergamma lowergamma besselj bessely besseli besselk airyai airybi "
    "Min Max re im conjugate arg "
    "Sum Product Integral Derivative Limit "
    "simplify expand factor together cancel apart trigsimp radsimp "
    "diff integrate limit summation "
    "Matrix eye zeros ones diag "
    "And Or Not Eq Ne Lt Le Gt Ge Piecewise "
    "gcd lcm mod primerange isprime totient divisors"
).split()

# Not for the model to write — these are what SymPy's own transformations emit.
# `auto_symbol` rewrites a bare name as `Symbol('x')` and `auto_number` rewrites
# a literal as `Integer(2)` / `Float(...)` / `Rational(...)`, so a namespace
# without them parses nothing at all: every expression dies on
# "name 'Symbol' is not defined" long before any mathematics happens.
_PARSER_HELPERS = ("Symbol", "Integer", "Float", "Rational", "Function")

_ALLOWED_CONSTS = {
    "pi": sympy.pi,
    "E": sympy.E,
    "e": sympy.E,
    "I": sympy.I,
    "oo": sympy.oo,
    "inf": sympy.oo,
    "infty": sympy.oo,
    "zoo": sympy.zoo,
    "nan": sympy.nan,
    "GoldenRatio": sympy.GoldenRatio,
    "EulerGamma": sympy.EulerGamma,
    "true": sympy.true,
    "false": sympy.false,
}


def _resolve(names: tuple[str, ...]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in names:
        obj = getattr(sympy, name, None)
        if obj is not None:
            out[name] = obj
    return out


_FUNCTIONS: dict[str, Any] = {**_resolve(tuple(_ALLOWED_FUNCS)), "ln": sympy.log}
_HELPERS: dict[str, Any] = _resolve(_PARSER_HELPERS)

# The full roster, for the "is this name known" checks. Not what gets handed to
# the parser — see :func:`_namespace_for`.
SAFE_NAMESPACE: dict[str, Any] = {**_ALLOWED_CONSTS, **_FUNCTIONS, **_HELPERS}


def _namespace_for(source: str) -> dict[str, Any]:
    """The namespace this particular expression is parsed against.

    A function name is only bound when the source actually *calls* it. Otherwise
    `beta` and `gamma` — two of the most common variable names in physics and
    statistics — resolve to SymPy's Beta and Gamma functions, and `alpha*beta`
    dies with "unsupported operand type(s) for *: 'Symbol' and 'FunctionClass'".
    Leaving the name unbound lets SymPy's own `auto_symbol` do the right thing
    and make it a symbol.
    """
    called = set(_CALL_RE.findall(source))
    return {
        **_ALLOWED_CONSTS,
        **{name: obj for name, obj in _FUNCTIONS.items() if name in called},
        **_HELPERS,
    }

# convert_xor makes `x^2` mean exponentiation, which is what a model writing
# maths means by it every single time. implicit_multiplication turns `2x` into
# `2*x`; the *application* variant is left off on purpose, since it would also
# read `f(x)` as `f*(x)` and quietly change what a claim says.
_TRANSFORMS = standard_transformations + (convert_xor, implicit_multiplication)

# ── LaTeX pre-pass ────────────────────────────────────────────────────────

_LATEX_FUNCS = (
    "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh "
    "exp log ln max min gcd lcm det"
).split()

_LATEX_SYMBOLS = {
    r"\\cdot": "*",
    r"\\times": "*",
    r"\\div": "/",
    r"\\pi\b": "pi",
    r"\\infty": "oo",
    r"\\alpha\b": "alpha",
    r"\\beta\b": "beta",
    r"\\gamma\b": "gamma",
    r"\\theta\b": "theta",
    r"\\lambda\b": "lamda",
    r"\\mu\b": "mu",
    r"\\sigma\b": "sigma",
    r"\\phi\b": "phi",
    r"\\omega\b": "omega",
    r"\\le\b": "<=",
    r"\\leq\b": "<=",
    r"\\ge\b": ">=",
    r"\\geq\b": ">=",
    r"\\neq\b": "!=",
    r"\\to\b": ",",
    r"\\,": " ",
    r"\\;": " ",
    r"\\!": "",
    r"\\quad": " ",
    r"\\qquad": " ",
    r"\\left": "",
    r"\\right": "",
    r"\\displaystyle": "",
    r"\\dfrac": r"\\frac",
    r"\\tfrac": r"\\frac",
}


def _read_group(text: str, start: int) -> tuple[str, int]:
    """Read a ``{...}`` group beginning at *start*; return its body and the
    index just past the closing brace. A bare token (``\\frac12``) counts as a
    one-character group, which is how LaTeX itself reads it."""
    if start >= len(text):
        raise MathParseError("unbalanced braces in LaTeX input")
    if text[start] != "{":
        return text[start], start + 1
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : i], i + 1
    raise MathParseError("unbalanced braces in LaTeX input")


def _expand_frac_sqrt(text: str) -> str:
    """Rewrite ``\\frac{a}{b}`` and ``\\sqrt[n]{a}`` into infix SymPy.

    Done by hand rather than with a regex: both take *braced groups* that can
    themselves contain fractions, and a regex has no way to match the right
    closing brace.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        if text.startswith(r"\frac", i):
            num, j = _read_group(text, i + 5)
            den, k = _read_group(text, j)
            out.append(f"(({_expand_frac_sqrt(num)})/({_expand_frac_sqrt(den)}))")
            i = k
        elif text.startswith(r"\sqrt", i):
            j = i + 5
            degree = "2"
            if j < len(text) and text[j] == "[":
                close = text.find("]", j)
                if close == -1:
                    raise MathParseError("unbalanced brackets in \\sqrt")
                degree, j = text[j + 1 : close], close + 1
            body, k = _read_group(text, j)
            out.append(
                f"(({_expand_frac_sqrt(body)})**(1/({_expand_frac_sqrt(degree)})))"
            )
            i = k
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def latex_to_sympy(text: str) -> str:
    """Best-effort LaTeX → SymPy source. Input already in SymPy syntax passes
    through essentially untouched, so callers need not know which they have."""
    s = text.strip()
    if s.startswith("$$") and s.endswith("$$"):
        s = s[2:-2]
    elif s.startswith("$") and s.endswith("$"):
        s = s[1:-1]
    s = s.replace(r"\[", "").replace(r"\]", "")

    s = _expand_frac_sqrt(s)
    for pattern, repl in _LATEX_SYMBOLS.items():
        s = re.sub(pattern, repl, s)
    # `\sin` → `sin`; done after the symbol table so `\sec` isn't eaten early.
    for fn in _LATEX_FUNCS:
        s = re.sub(rf"\\{fn}\b", fn, s)
    # Remaining braces are grouping (`x^{n+1}`), which parentheses express.
    s = s.replace("{", "(").replace("}", ")")
    # A stray control sequence would parse as a free symbol and make nonsense
    # verify cleanly; drop the backslash and let the name stand or fail.
    return s.replace("\\", " ").strip()


# ── the parser ────────────────────────────────────────────────────────────


_CALL_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")

# Words that appear in a sentence about mathematics and never in mathematics.
# One of these is decisive on its own.
_PROSE_WORDS = frozenset(
    "the an and or of in on for to is are be find solve prove show "
    "compute evaluate calculate determine given where such that with which "
    "equation expression function value roots root answer problem question "
    "following above below then thus hence we let it its this these those"
    .split()
)

# Multi-character symbol names a real claim genuinely uses. Anything else that
# is a bare alphabetic word is a candidate piece of prose.
_KNOWN_SYMBOL_NAMES = frozenset(
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lamda lambda mu "
    "nu xi omicron rho sigma tau upsilon phi chi psi omega "
    "Alpha Beta Gamma Delta Theta Lambda Sigma Phi Psi Omega "
    "eps dx dy dz dt dr ds du dv".split()
)

_WORD_RE = re.compile(r"[A-Za-z]{2,}")

# Three unrelated word-symbols in one expression is not notation any more.
_MAX_WORD_SYMBOLS = 2


def _reject_prose(source: str, expr: Any, what: str) -> None:
    """Refuse an expression that is really a sentence.

    Found in a live run: a claim arrived without its ``equation`` field, the
    verifier fell back to the problem statement, and ``Solve the quadratic
    equation x^2-5x+6=0`` parsed cleanly — as a *product of symbols* named
    Solve, the, quadratic and equation. Substituting the correct roots into that
    left a non-zero residual, so a right answer came back **refuted**, with a
    counterexample reading ``4*Solve*equation*quadratic*the - 4``.

    That is the worst verdict this system can produce, reached from a claim that
    was merely incomplete. Prose is refused outright now, which makes it an
    ``error`` — a verdict that claims nothing.
    """
    lowered = {word.lower() for word in _WORD_RE.findall(source)}
    stop_words = lowered & _PROSE_WORDS
    if stop_words:
        raise MathParseError(
            f"{what} looks like a sentence rather than an expression "
            f"(contains {', '.join(sorted(stop_words)[:3])!r}). "
            "Pass the mathematics on its own, in SymPy or LaTeX notation."
        )

    words = {
        symbol.name
        for symbol in getattr(expr, "free_symbols", set())
        if len(symbol.name) > 1 and symbol.name.isalpha()
        and symbol.name not in _KNOWN_SYMBOL_NAMES
    }
    if len(words) > _MAX_WORD_SYMBOLS:
        raise MathParseError(
            f"{what} parsed as {len(words)} unrelated word-like symbols "
            f"({', '.join(sorted(words)[:4])}), which means it is text and not "
            "an expression. Pass the mathematics on its own."
        )


def _reject_unknown_calls(source: str, what: str) -> None:
    """Refuse ``name(...)`` where *name* is a function we do not know.

    Without this the ``implicit_multiplication`` transformation silently reads
    ``LambertW(1)`` as ``LambertW * 1`` — a free symbol times its argument. The
    expression then parses cleanly, refuses to simplify, and the verifier
    announces that a correct answer is **refuted**. A wrong refutation is the
    costliest verdict this system can produce (it sends the agent off to rewrite
    a solution that was right), so an unknown function is turned into an
    ``error``, which claims nothing at all.

    Single letters are exempt, because ``x(x+1)`` really is multiplication in
    the notation people write — and no one names a function ``x``.
    """
    unknown = {
        name
        for name in _CALL_RE.findall(source)
        if len(name) > 1 and name not in SAFE_NAMESPACE
    }
    if unknown:
        raise MathParseError(
            f"{what} calls function(s) this verifier does not know: "
            f"{', '.join(sorted(unknown))}"
        )


def parse_math(text: str, *, what: str = "expression") -> sympy.Expr:
    """Parse one expression. Raises :class:`MathParseError` on anything else."""
    raw = (text or "").strip()
    if not raw:
        raise MathParseError(f"empty {what}")
    if len(raw) > MAX_EXPR_CHARS:
        raise MathParseError(f"{what} is too long ({len(raw)} chars)")

    source = latex_to_sympy(raw)
    if _FORBIDDEN.search(source):
        raise MathParseError(f"{what} contains a construct that is not mathematics")
    _reject_unknown_calls(source, what)

    try:
        expr = parse_expr(
            source,
            local_dict={},
            global_dict=_namespace_for(source),
            transformations=_TRANSFORMS,
            evaluate=True,
        )
    except MathParseError:
        raise
    except Exception as exc:  # noqa: BLE001 — sympy raises a zoo of parser errors
        raise MathParseError(f"could not parse {what} {raw!r}: {exc}") from exc

    if not isinstance(expr, (sympy.Expr, sympy.logic.boolalg.Boolean, sympy.MatrixBase)):
        raise MathParseError(f"{what} {raw!r} did not read as a mathematical expression")

    # A name we don't know, *called*, parses as an undefined function — and an
    # undefined function neither simplifies nor evaluates, so every check
    # involving it fails. Left alone, "I have never heard of this function"
    # comes back as `refuted`: the verifier declaring a correct answer wrong,
    # which is the single costliest verdict it can produce. Refused as an
    # `error` instead, which says nothing about the answer.
    from sympy.core.function import AppliedUndef

    unknown = {type(node).__name__ for node in expr.atoms(AppliedUndef)}
    if unknown:
        raise MathParseError(
            f"{what} uses function(s) this verifier does not know: {', '.join(sorted(unknown))}"
        )

    _reject_prose(source, expr, what)
    return expr  # type: ignore[return-value]


def parse_relation(text: str, *, what: str = "equation") -> tuple[sympy.Expr, sympy.Expr]:
    """Split ``lhs = rhs`` into a pair. A bare expression is read as ``expr = 0``,
    which is how a model writing "the equation x**2-4" means it."""
    raw = (text or "").strip()
    # `==` first so it isn't split into two empty halves by the `=` branch.
    for sep in ("==", "="):
        if sep in raw:
            left, _, right = raw.partition(sep)
            return parse_math(left, what=f"{what} left side"), parse_math(
                right, what=f"{what} right side"
            )
    return parse_math(raw, what=what), sympy.Integer(0)


def parse_symbol(name: str, default: str = "x") -> sympy.Symbol:
    """Read a variable name. Falls back to *default* rather than failing: the
    variable is almost always inferable, and refusing a claim over a missing
    ``variable`` field would turn a checkable answer into an ``error``."""
    raw = (name or "").strip() or default
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,30}", raw):
        raise MathParseError(f"{raw!r} is not a valid variable name")
    return sympy.Symbol(raw)


def free_symbols_of(*exprs: Any) -> list[sympy.Symbol]:
    """Every free symbol across *exprs*, in a stable (sorted) order.

    Stable because the numeric sampler seeds per-variable draws by position —
    an unordered set would make an otherwise fixed ``seed`` meaningless.
    """
    seen: set[sympy.Symbol] = set()
    for expr in exprs:
        if hasattr(expr, "free_symbols"):
            seen |= {s for s in expr.free_symbols if isinstance(s, sympy.Symbol)}
    return sorted(seen, key=lambda s: s.name)
