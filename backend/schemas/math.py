"""Contracts for the math verification contour — a LEAF package member.

Shared by four layers that must never import each other: the ``mathkit`` engine
that produces an outcome, the ``math_verify`` tool that streams it, the store
that persists it, and the ``/api/math`` route that re-runs it. Keeping the shape
here is what lets the verifier run in a *child process* — the worker returns
plain JSON and the parent revalidates it through :class:`VerifyOutcome`.

The status vocabulary is the load-bearing part. Four outcomes plus an error, and
they are not interchangeable:

``verified``      the reverse substitution closed — symbolically, and numerically
                  where a numeric path applies.
``refuted``       the check ran and *disagreed*. Always carries a counterexample.
``partial``       part of the claim closed (roots substitute, completeness of the
                  set unproven) — honest, and deliberately not green.
``inconclusive``  nothing here is machine-checkable (a proof, a construction).
``error``         the tool itself failed: unparseable input, a timeout, a
                  singularity in the sampler. **Not** a statement about the answer.

Collapsing ``inconclusive`` into ``verified``, or ``error`` into ``refuted``, is
what turns the badge into decoration — see the antipatterns in the design.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# What the deterministic verifier knows how to check. ``proof`` and ``other``
# are accepted on purpose: a model that cannot honestly fit its claim into a
# checkable kind should say so and be routed to the subagent, rather than
# mislabel the claim to make a green badge appear.
VerifyKind = Literal[
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
]

VerifyStatus = Literal["verified", "refuted", "partial", "inconclusive", "error"]

VerifierKind = Literal["deterministic", "subagent"]

# Kinds the deterministic path deliberately declines. Named here rather than
# inferred from a missing registry entry so the refusal is a decision, not an
# accident of import order.
UNCHECKABLE_KINDS: frozenset[str] = frozenset({"proof", "other"})

# Fixed by default so one answer cannot be `verified` on one run and `partial`
# on the next. A caller may override it, but never with a clock or a random.
DEFAULT_SEED = 42


class SymbolicCheck(BaseModel):
    """The CAS half: did ``simplify(claim - truth)`` collapse to zero."""

    ok: bool
    detail: str = ""


class NumericCheck(BaseModel):
    """The sampled half: how far apart the two sides got over N points.

    ``max_rel_err`` is the one that decides, not ``max_abs_err`` — an absolute
    threshold silently passes everything near zero and fails everything large.
    """

    ok: bool
    max_abs_err: float = 0.0
    max_rel_err: float = 0.0
    samples: int = 0
    detail: str = ""


class VerifyOutcome(BaseModel):
    """One verification of one claim.

    ``problem`` is the weak link of the whole contour and is stored for exactly
    that reason: the verifier substitutes into the statement it was *handed*, so
    a claim proven against a quietly rewritten problem is still a green badge.
    The UI shows this string to the user in the expanded panel, where a mismatch
    with the original question is visible in a second.
    """

    status: VerifyStatus
    kind: VerifyKind
    problem: str = ""
    claim: dict[str, Any] = Field(default_factory=dict)
    symbolic: SymbolicCheck | None = None
    numeric: NumericCheck | None = None
    # Required whenever status is `refuted`: the model needs a concrete point to
    # see where its method broke, not merely the word "wrong".
    counterexample: dict[str, Any] | None = None
    detail: str = ""
    # Plain-language description of what was actually done ("differentiated the
    # antiderivative and simplified the difference"). Shown in the panel so the
    # badge can be audited rather than trusted.
    method: str = ""
    verifier: VerifierKind = "deterministic"
    # 1 or 2. A `refuted` claim earns exactly one automatic rewrite; the first
    # attempt stays in the history rather than being replaced by the second.
    attempt: int = 1
    seed: int = DEFAULT_SEED
    duration_ms: int = 0


class RecheckRequest(BaseModel):
    """Body of ``POST /api/math/recheck`` — the "Re-check" button.

    Carries the claim, never the solution: the subagent verifier is independent
    by construction, and the surest way to lose that is to let the route accept
    the reasoning it is meant not to see.
    """

    chat_id: str = ""
    message_id: str = ""
    kind: VerifyKind
    problem: str
    claim: dict[str, Any] = Field(default_factory=dict)
    domain: dict[str, Any] | None = None
    seed: int = DEFAULT_SEED
