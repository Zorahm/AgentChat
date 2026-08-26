"""The deterministic verifier: does each kind reach the right verdict.

These run the engine in-process (no worker), because what is under test is the
mathematics and the *status semantics*, not the subprocess plumbing.

The status assertions are the point of the file. A verifier that returns
`verified` for everything passes a naive "did it run" test and is worthless; the
cases below pair each correct answer with a wrong one, and pin the three
outcomes that are neither pass nor fail — `partial`, `inconclusive`, `error` —
because collapsing any of those into a neighbour is what makes the badge lie.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from mathkit.verifiers.registry import CHECKABLE_KINDS, run_verification  # noqa: E402


def verify(kind: str, claim: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return run_verification({"kind": kind, "problem": extra.pop("problem", ""), "claim": claim, **extra})


# ── the happy path, one per kind ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("kind", "claim"),
    [
        ("root", {"equation": "x**2 - 5*x + 6 = 0", "variable": "x", "roots": ["2", "3"]}),
        ("identity", {"lhs": "sin(x)**2 + cos(x)**2", "rhs": "1"}),
        ("derivative", {"function": "x**3*sin(x)", "variable": "x",
                        "derivative": "3*x**2*sin(x) + x**3*cos(x)"}),
        ("integral_indef", {"integrand": "x*exp(x)", "variable": "x",
                            "antiderivative": "(x-1)*exp(x)"}),
        ("integral_def", {"integrand": "exp(-x**2)", "variable": "x",
                          "lower": "-oo", "upper": "oo", "value": "sqrt(pi)"}),
        ("limit", {"expression": "sin(x)/x", "variable": "x", "point": "0", "value": "1"}),
        ("sum", {"term": "1/n**2", "index": "n", "lower": "1", "upper": "oo", "value": "pi**2/6"}),
        ("linalg", {"task": "solve", "matrix": [["2", "1"], ["1", "3"]],
                    "rhs": ["5", "10"], "solution": ["1", "3"]}),
        ("linalg", {"task": "eigenvector", "matrix": [["2", "0"], ["0", "3"]],
                    "vector": ["1", "0"], "eigenvalue": "2"}),
        ("linalg", {"task": "determinant", "matrix": [["1", "2"], ["3", "4"]], "value": "-2"}),
        ("inequality", {"statement": "x**2 + 1 > 0"}),
        ("probability", {"value": "1/6", "trial": "randint(1,6) + randint(1,6) == 7",
                         "trials": 30000}),
        ("combinatorics", {"value": "252", "space": "itertools.combinations(range(10), 5)",
                           "predicate": "True"}),
    ],
)
def test_correct_answers_verify(kind: str, claim: dict[str, Any]) -> None:
    assert verify(kind, claim)["status"] == "verified"


# ── the wrong answers ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("kind", "claim"),
    [
        ("root", {"equation": "x**2 - 5*x + 6", "variable": "x", "roots": ["2", "4"]}),
        # Every root named is genuine, but one is missing. The answer to "find
        # the roots" is still wrong, and reporting it green because each number
        # checks out individually is the exact failure this contour exists for.
        ("root", {"equation": "x**2 - 5*x + 6", "variable": "x", "roots": ["2"]}),
        ("identity", {"lhs": "sin(2*x)", "rhs": "2*sin(x)"}),
        ("derivative", {"function": "x**3", "variable": "x", "derivative": "2*x**2"}),
        ("integral_indef", {"integrand": "x*exp(x)", "variable": "x", "antiderivative": "x*exp(x)"}),
        ("integral_def", {"integrand": "x**2", "variable": "x",
                          "lower": "0", "upper": "1", "value": "1/2"}),
        ("limit", {"expression": "sin(x)/x", "variable": "x", "point": "0", "value": "0"}),
        ("linalg", {"task": "solve", "matrix": [["2", "1"], ["1", "3"]],
                    "rhs": ["5", "10"], "solution": ["2", "1"]}),
        ("inequality", {"statement": "x**2 - 1 > 0"}),
        ("probability", {"value": "1/4", "trial": "randint(1,6) + randint(1,6) == 7",
                         "trials": 30000}),
        ("combinatorics", {"value": "250", "space": "itertools.combinations(range(10), 5)",
                           "predicate": "True"}),
    ],
)
def test_wrong_answers_are_refuted(kind: str, claim: dict[str, Any]) -> None:
    result = verify(kind, claim)
    assert result["status"] == "refuted"
    # An agent told only "wrong" can do nothing but guess again; the whole point
    # of the single automatic rewrite is that it starts from a concrete point.
    assert result["counterexample"], "a refutation must carry a counterexample"


# ── the three statuses that are neither pass nor fail ─────────────────────


def test_proof_is_inconclusive_not_verified() -> None:
    """A proof is not machine-checkable, and must not be dressed up as checked."""
    result = verify("proof", {"statement": "sqrt(2) is irrational"})
    assert result["status"] == "inconclusive"


def test_unknown_kind_is_inconclusive_and_lists_the_real_ones() -> None:
    result = verify("other", {"anything": "at all"})
    assert result["status"] == "inconclusive"
    assert "root" in result["detail"] and "identity" in result["detail"]


def test_unparseable_claim_is_error_not_refuted() -> None:
    """The difference that keeps a correct solution from being rewritten.

    `error` means the checker failed. Reading it as `refuted` sends the agent
    off to "fix" an answer that may well be right — the worst outcome the whole
    design can produce.
    """
    result = verify("derivative", {"function": "x**", "variable": "x", "derivative": "1"})
    assert result["status"] == "error"


def test_transcendental_roots_are_partial_not_verified() -> None:
    """The root substitutes, but completeness cannot be established.

    Saying `verified` here would claim something never checked: that no other
    root exists.
    """
    result = verify(
        "root",
        {"equation": "cos(x) - x", "variable": "x", "roots": ["0.7390851332151607"]},
    )
    assert result["status"] == "partial"
    assert "complete" in result["detail"].lower()


@pytest.mark.parametrize(
    ("integrand", "variable", "lower", "upper", "value"),
    [
        # The one that was reported: mpmath.quad returns 1.18 here, so the
        # verifier used to refute a correct π/6 and send the model off to
        # "fix" a solution that was right all along.
        ("sin(x**3)/x", "x", "0", "oo", "pi/6"),
        # quad gets the textbook Dirichlet integral wrong too — 1.70 vs π/2.
        ("sin(u)/u", "u", "0", "oo", "pi/2"),
        ("sin(x**2)", "x", "0", "oo", "sqrt(2*pi)/4"),
        ("cos(x)/(1+x**2)", "x", "0", "oo", "pi/(2*E)"),
    ],
)
def test_oscillatory_improper_integrals_are_not_refuted(
    integrand: str, variable: str, lower: str, upper: str, value: str
) -> None:
    """Plain quadrature does not merely struggle on these — it returns a
    confident wrong number. The verifier has to reach for `quadosc`, or abstain;
    what it must never do is believe `quad` and refute a correct answer."""
    result = verify(
        "integral_def",
        {"integrand": integrand, "variable": variable, "lower": lower,
         "upper": upper, "value": value},
    )
    assert result["status"] == "verified", result["detail"]


@pytest.mark.parametrize(
    ("integrand", "variable", "value"),
    [
        ("sin(x**3)/x", "x", "pi/3"),
        ("sin(u)/u", "u", "1"),
    ],
)
def test_a_wrong_oscillatory_integral_is_still_refuted(
    integrand: str, variable: str, value: str
) -> None:
    """The other half: fixing the false refutation must not blunt the real one."""
    result = verify(
        "integral_def",
        {"integrand": integrand, "variable": variable, "lower": "0",
         "upper": "oo", "value": value},
    )
    assert result["status"] == "refuted"


def test_a_closed_form_match_is_never_refuted_by_quadrature_alone() -> None:
    """A CAS closed form equal to the claim is a proof. When the numeric side
    dissents, the honest reading is "the two methods disagree" — `partial` —
    never "your answer is wrong"."""
    from mathkit.verifiers import calculus

    original = calculus._quadrature
    # Force the pathological case: a trusted-looking quadrature that is wrong.
    calculus._quadrature = lambda *a, **k: (complex(9.0), "stubbed", True)  # type: ignore[assignment]
    try:
        result = verify(
            "integral_def",
            {"integrand": "x**2", "variable": "x", "lower": "0", "upper": "1", "value": "1/3"},
        )
    finally:
        calculus._quadrature = original  # type: ignore[assignment]

    assert result["status"] == "partial"
    assert result["status"] != "refuted"


def test_a_wrong_decimal_root_is_still_refuted() -> None:
    """The other half of the float rule: abstaining must not mean accepting."""
    result = verify("root", {"equation": "cos(x) - x", "variable": "x", "roots": ["0.65"]})
    assert result["status"] == "refuted"


def test_a_decimal_answer_is_not_refuted_for_being_decimal() -> None:
    """`sqrt(2)` written as 1.4142135623730951 is a right answer, not a wrong one."""
    result = verify(
        "root", {"equation": "x**2 - 2 = 0", "variable": "x",
                 "roots": ["1.4142135623730951", "-1.4142135623730951"]}
    )
    assert result["status"] in ("verified", "partial")


def test_a_special_function_in_the_answer_still_verifies() -> None:
    """Closed forms come back in terms of W, Ei, Si — not just elementary functions."""
    result = verify(
        "root", {"equation": "exp(x) + x", "variable": "x", "roots": ["-LambertW(1)"]}
    )
    assert result["status"] in ("verified", "partial")


def test_an_unknown_function_is_an_error_not_a_refutation() -> None:
    """The costliest possible verdict is a wrong `refuted`.

    An unrecognised name, called, parses as an undefined function; those neither
    simplify nor evaluate, so every check involving one fails. Reported as an
    error, the answer is untouched — reported as a refutation, the agent rewrites
    a correct solution.
    """
    result = verify(
        "identity", {"lhs": "wobble(x) + 1", "rhs": "wobble(x) + 1"}
    )
    assert result["status"] == "error"
    assert "wobble" in result["detail"]


# ── independence guards ───────────────────────────────────────────────────


def test_simulation_that_names_the_answer_is_refused() -> None:
    """Code that spells out the claim cannot be an independent check of it."""
    result = verify(
        "probability",
        {"value": "0.5", "trial": "random() < 0.5"},
    )
    assert result["status"] == "inconclusive"
    assert "confirm the answer with the answer" in result["detail"]


def test_enumeration_that_names_the_answer_is_refused() -> None:
    result = verify("combinatorics", {"value": "252", "space": "range(252)", "predicate": "True"})
    assert result["status"] == "inconclusive"


def test_probability_without_an_experiment_is_inconclusive() -> None:
    """No independent path was supplied, so nothing was established."""
    result = verify("probability", {"value": "1/6"})
    assert result["status"] == "inconclusive"


def test_probability_outside_the_unit_interval_is_refuted() -> None:
    result = verify("probability", {"value": "1.4", "trial": "random() < 0.3"})
    assert result["status"] == "refuted"


# ── determinism and parsing ───────────────────────────────────────────────


def test_same_claim_gives_the_same_verdict_twice() -> None:
    """A badge that flickers between runs is a badge nobody reads."""
    claim = {"value": "1/6", "trial": "randint(1,6) + randint(1,6) == 7", "trials": 20000}
    first = verify("probability", claim)
    second = verify("probability", claim)
    assert first["status"] == second["status"]
    assert first["numeric"]["max_abs_err"] == second["numeric"]["max_abs_err"]


def test_latex_claims_parse() -> None:
    """Models write claims the way they write answers."""
    result = verify("identity", {"lhs": r"\frac{1}{2}\cdot 2x", "rhs": "x"})
    assert result["status"] == "verified"


def test_parser_refuses_attribute_access() -> None:
    """The namespace is closed, so `__class__` is the only way out of it."""
    result = verify("identity", {"lhs": "(1).__class__", "rhs": "1"})
    assert result["status"] == "error"


def test_a_prose_problem_is_never_parsed_as_the_equation() -> None:
    """The bug this exists for, caught on a live run.

    A claim arrived without its `equation` field. The verifier fell back to the
    problem statement, and "Solve the quadratic equation x^2-5x+6=0" parsed
    cleanly — as a product of symbols named Solve, the, quadratic, equation.
    The correct roots then failed to substitute, and 2 and 3 came back
    **refuted** with a counterexample reading `4*Solve*equation*quadratic*the-4`.

    A wrong refutation makes the agent rewrite a correct solution. So an
    incomplete claim has to be an `error`, which claims nothing.
    """
    result = verify(
        "root",
        {"roots": ["2", "3"]},
        problem="Solve the quadratic equation x^2 - 5x + 6 = 0",
    )
    assert result["status"] == "error"
    assert "equation" in result["detail"]


@pytest.mark.parametrize(
    ("kind", "claim"),
    [
        ("root", {"roots": ["2"]}),
        ("identity", {"note": "they are equal"}),
        ("inequality", {"note": "it always holds"}),
    ],
)
def test_a_claim_missing_its_field_is_an_error(kind: str, claim: dict[str, Any]) -> None:
    result = verify(kind, claim, problem="Find the answer to the given problem")
    assert result["status"] == "error"


def test_prose_in_the_equation_field_is_refused_too() -> None:
    """Defence in depth: the model can put a sentence in the right field."""
    result = verify(
        "root",
        {"equation": "the quadratic equation x**2 - 5*x + 6 = 0", "roots": ["2", "3"]},
    )
    assert result["status"] == "error"
    assert "sentence" in result["detail"] or "text" in result["detail"]


def test_ordinary_multi_letter_variables_still_parse() -> None:
    """The prose guard must not refuse real notation."""
    result = verify("identity", {"lhs": "alpha*beta + gamma", "rhs": "gamma + alpha*beta"})
    assert result["status"] == "verified"


def test_problem_is_echoed_back_for_the_user_to_audit() -> None:
    """The badge shows this string; a drifted restatement is caught by eye."""
    result = verify("identity", {"lhs": "x", "rhs": "x"}, problem="prove x = x")
    assert result["problem"] == "prove x = x"


def test_every_checkable_kind_has_a_strategy() -> None:
    assert set(CHECKABLE_KINDS) == {
        "root", "identity", "derivative", "integral_indef", "integral_def",
        "limit", "sum", "linalg", "probability", "combinatorics", "inequality",
    }
