"""Restricted Python for calculation, used by ``math_eval`` and Monte Carlo.

What this is: a *calculation* sandbox. The namespace is closed — a curated set
of builtins, a fixed set of preloaded maths modules, no ``import``, no ``open``,
no dunder access — and it runs inside the math worker process, which the parent
kills on timeout. That is enough to keep a stray ``while True`` or an accidental
file write out of a chat that has no shell.

What this is not: an OS-level sandbox. It is not a substitute for the bwrap cage
that ``bash_tool`` runs in, and nothing here should ever be treated as one. The
reason it exists at all is that an agent restricted to the math tools has no
shell to fall back on, so its arithmetic must not require one.
"""

from __future__ import annotations

import ast
import builtins
import io
import re
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from typing import Any

# Attribute access is the escape: `(0).__class__.__base__.__subclasses__()`
# reaches the real builtins from inside any closed namespace. Refused textually
# because there is no reliable way to refuse it at runtime.
_FORBIDDEN_SOURCE = re.compile(r"__|\bimport\b|\bopen\b|\bexec\b|\beval\b|\bcompile\b|\bglobals\b|\blocals\b")

MAX_CODE_CHARS = 20_000
MAX_OUTPUT_CHARS = 20_000

_SAFE_BUILTIN_NAMES = (
    "abs all any bool bin callable chr complex dict divmod enumerate filter float "
    "format frozenset getattr hasattr hash hex id int isinstance issubclass iter len "
    "list map max min next object oct ord pow print range repr reversed round set "
    "slice sorted str sum tuple type zip "
    "True False None "
    "ArithmeticError AssertionError AttributeError Exception IndexError KeyError "
    "OverflowError StopIteration TypeError ValueError ZeroDivisionError"
).split()


def _safe_builtins() -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in _SAFE_BUILTIN_NAMES:
        if hasattr(builtins, name):
            out[name] = getattr(builtins, name)
    out["True"], out["False"], out["None"] = True, False, None
    return out


# Modules the model may use by name. Absent optional ones simply don't appear,
# rather than turning every call into an ImportError the model can't act on.
_MODULE_NAMES = (
    "math",
    "cmath",
    "random",
    "itertools",
    "functools",
    "fractions",
    "decimal",
    "statistics",
    "collections",
    "sympy",
    "mpmath",
    "numpy",
    "scipy",
)


class SandboxError(RuntimeError):
    """The submitted code could not be run at all — never a statement about maths."""


@dataclass
class EvalResult:
    """What ``math_eval`` reports back."""

    stdout: str = ""
    result: str | None = None
    error: str | None = None
    names: dict[str, str] = field(default_factory=dict)


def build_globals(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """The closed namespace: safe builtins, maths modules, plus *extra*."""
    namespace: dict[str, Any] = {"__builtins__": _safe_builtins()}
    for name in _MODULE_NAMES:
        try:
            namespace[name] = __import__(name)
        except ImportError:
            continue
    # Convenience aliases the model reaches for constantly.
    if "numpy" in namespace:
        namespace["np"] = namespace["numpy"]
    if "sympy" in namespace:
        namespace["sp"] = namespace["sympy"]
    if extra:
        namespace.update(extra)
    return namespace


def _check_source(code: str, what: str) -> str:
    source = (code or "").strip()
    if not source:
        raise SandboxError(f"empty {what}")
    if len(source) > MAX_CODE_CHARS:
        raise SandboxError(f"{what} is too long ({len(source)} chars)")

    offender = _FORBIDDEN_SOURCE.search(source)
    if offender is None:
        return source

    # Naming the construct is not enough — a model told only "import is refused"
    # rewrites the import and calls again. Observed twice in a row on a small
    # model, which is two wasted round trips and a worse answer. The `import`
    # case gets the fix rather than the rule, because there IS one: the modules
    # are already in the namespace.
    if offender.group(0) == "import":
        raise SandboxError(
            f"{what} must not import anything — sympy (also `sp`), numpy (`np`), "
            "mpmath, math, cmath, random, itertools, functools, fractions, "
            "decimal, statistics and collections are ALREADY available. Delete "
            "the import lines and run the rest unchanged."
        )
    raise SandboxError(
        f"{what} uses `{offender.group(0)}`, which this sandbox refuses "
        "(open, exec/eval/compile, globals/locals, and dunder attribute access "
        "are all unavailable). Rewrite the calculation without it."
    )


def run_script(code: str, extra: dict[str, Any] | None = None) -> EvalResult:
    """Execute *code*, capturing stdout and the value of its last expression.

    The last-expression rule mirrors a REPL, because that is how the model
    writes these: a few statements, then the thing it wants to see.
    """
    source = _check_source(code, "code")
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        return EvalResult(error=f"SyntaxError: {exc}")

    tail: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(body=tree.body.pop().value)  # type: ignore[attr-defined]

    namespace = build_globals(extra)
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            exec(compile(tree, "<math_eval>", "exec"), namespace)  # noqa: S102
            value = (
                eval(compile(tail, "<math_eval>", "eval"), namespace)  # noqa: S307
                if tail is not None
                else None
            )
    except Exception as exc:  # noqa: BLE001 — the model needs the real error text
        return EvalResult(
            stdout=buffer.getvalue()[:MAX_OUTPUT_CHARS],
            error=f"{type(exc).__name__}: {exc}",
        )

    return EvalResult(
        stdout=buffer.getvalue()[:MAX_OUTPUT_CHARS],
        result=None if value is None else repr(value)[:MAX_OUTPUT_CHARS],
    )


def compile_expression(code: str, what: str) -> Any:
    """Compile a single expression for repeated evaluation in a hot loop."""
    source = _check_source(code, what)
    try:
        return compile(ast.Expression(ast.parse(source, mode="eval").body), f"<{what}>", "eval")
    except SyntaxError as exc:
        raise SandboxError(f"{what} is not a valid Python expression: {exc}") from exc


def mentions_literal(code: str, value: str) -> bool:
    """True when *code* contains *value* as a bare literal.

    Used to refuse a Monte Carlo experiment or an enumeration that simply spells
    out the answer it is meant to be independent of — the "fitted code"
    antipattern. Crude, and deliberately so: a check that can be argued with is
    a check that gets argued with.
    """
    needle = (value or "").strip()
    if not needle or len(needle) < 2:
        return False
    return re.search(rf"(?<![\w.]){re.escape(needle)}(?![\w.])", code or "") is not None
