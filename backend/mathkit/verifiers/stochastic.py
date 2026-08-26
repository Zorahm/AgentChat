"""Probability and counting — the genuinely orthogonal checks.

These two are the most valuable rows in the whole table, because the checking
path shares nothing at all with the solving path. A probability derived by
conditioning and inclusion–exclusion is checked by *playing the game* a hundred
thousand times; a count derived by a binomial argument is checked by *listing
the objects*. No amount of subtle reasoning error survives that.

The price is that the model has to hand over an experiment or a sample space,
and a model under pressure will hand over one that encodes the answer it wants.
Hence :func:`mathkit.pysandbox.mentions_literal`: code that spells out the
claimed value is refused rather than run, and the claim goes to the subagent.
"""

from __future__ import annotations

import random
import time
from typing import Any

import sympy

from mathkit.numeric import CI_SIGMA, count_matching, wilson_interval
from mathkit.parsing import parse_math
from mathkit.pysandbox import (
    SandboxError,
    build_globals,
    compile_expression,
    mentions_literal,
)
from mathkit.verifiers.common import VerifyJob, outcome
from schemas.math import NumericCheck, SymbolicCheck, VerifyOutcome

# Enough trials that a 4σ interval is tighter than a third decimal place, while
# still finishing inside the worker's budget for a non-trivial experiment.
DEFAULT_TRIALS = 120_000
MIN_TRIALS = 4_000
TRIAL_SECONDS = 6.0

# A space bigger than this is not "small parameters" any more; enumerating it
# would turn the check into the harder problem.
MAX_ENUMERATION = 3_000_000


def _rng_namespace(seed: int) -> dict[str, Any]:
    """A seeded generator plus the shorthands an experiment actually uses."""
    rng = random.Random(seed)
    return build_globals(
        {
            "rng": rng,
            "random": rng.random,
            "randint": rng.randint,
            "randrange": rng.randrange,
            "uniform": rng.uniform,
            "choice": rng.choice,
            "choices": rng.choices,
            "sample": rng.sample,
            "gauss": rng.gauss,
            "shuffle": rng.shuffle,
        }
    )


def verify_probability(job: VerifyJob) -> VerifyOutcome:
    """Run the model's experiment and compare the frequency to the claim."""
    claimed_text = job.text("value", "probability", "p", "result")
    claimed = parse_math(claimed_text, what="the claimed probability")
    try:
        target = float(sympy.N(claimed, 20))
    except (TypeError, ValueError):
        return outcome(
            job,
            "error",
            method="Monte Carlo simulation",
            detail=f"the claimed probability {claimed_text!r} is not a number.",
        )

    trial_code = job.text("trial", "experiment", "simulation", "sample")
    if not trial_code:
        return outcome(
            job,
            "inconclusive",
            method="Monte Carlo simulation",
            detail=(
                "No experiment was supplied, so there is no independent path to "
                "check this probability against. Provide `trial`: a Python "
                "expression that runs ONE trial using `rng` and evaluates to True "
                "on success."
            ),
        )

    if mentions_literal(trial_code, claimed_text):
        return outcome(
            job,
            "inconclusive",
            method="Monte Carlo simulation",
            detail=(
                "The experiment references the claimed value itself, so simulating "
                "it would confirm the answer with the answer. Rewrite the trial to "
                "play out the random process without mentioning the result."
            ),
        )

    if not 0.0 <= target <= 1.0:
        return outcome(
            job,
            "refuted",
            method="range check before simulation",
            detail=f"{target:g} is not a probability — it lies outside [0, 1].",
            symbolic=SymbolicCheck(ok=False, detail="value outside [0,1]"),
            counterexample={"claimed": f"{target:g}"},
        )

    successes, trials, error = _simulate(trial_code, job.seed, job.claim.get("trials"))
    if error is not None:
        return outcome(
            job,
            "error",
            method="Monte Carlo simulation",
            detail=f"the experiment could not be run — {error}",
        )
    if trials < MIN_TRIALS:
        return outcome(
            job,
            "inconclusive",
            method="Monte Carlo simulation",
            detail=(
                f"Only {trials} trials completed within the time budget — too few "
                "to separate the claim from noise. Simplify the experiment."
            ),
        )

    observed = successes / trials
    low, high = wilson_interval(successes, trials)
    inside = low <= target <= high
    numeric = NumericCheck(
        ok=inside,
        max_abs_err=abs(observed - target),
        max_rel_err=abs(observed - target) / max(target, 1e-12),
        samples=trials,
        detail=f"{trials} seeded trials, {CI_SIGMA:g}σ Wilson interval [{low:.5f}, {high:.5f}]",
    )

    return outcome(
        job,
        "verified" if inside else "refuted",
        method=f"simulated the process {trials} times with seed {job.seed}",
        detail=(
            f"Simulation gives {observed:.5f}; the claim {target:.5f} lies inside the "
            f"{CI_SIGMA:g}σ interval [{low:.5f}, {high:.5f}]. The analytic answer and an "
            "independent simulation agree."
            if inside
            else f"Simulation gives {observed:.5f} over {trials} trials, and the claim "
            f"{target:.5f} lies outside the {CI_SIGMA:g}σ interval [{low:.5f}, {high:.5f}]. "
            "That gap is far too wide to be sampling noise."
        ),
        numeric_check=numeric,
        counterexample=(
            None
            if inside
            else {
                "simulated": f"{observed:.6f}",
                "claimed": f"{target:.6f}",
                "interval": f"[{low:.6f}, {high:.6f}]",
                "trials": str(trials),
            }
        ),
    )


def _simulate(code: str, seed: int, requested: Any) -> tuple[int, int, str | None]:
    """Evaluate the trial expression repeatedly until the count or the clock runs out."""
    try:
        compiled = compile_expression(code, "trial")
    except SandboxError as exc:
        return 0, 0, str(exc)

    try:
        budget = int(requested) if requested else DEFAULT_TRIALS
    except (TypeError, ValueError):
        budget = DEFAULT_TRIALS
    budget = max(MIN_TRIALS, min(budget, 2_000_000))

    namespace = _rng_namespace(seed)
    deadline = time.monotonic() + TRIAL_SECONDS
    successes = 0
    done = 0
    try:
        for done in range(1, budget + 1):
            if bool(eval(compiled, namespace)):  # noqa: S307 — closed namespace
                successes += 1
            if (done & 1023) == 0 and time.monotonic() > deadline:
                break
    except Exception as exc:  # noqa: BLE001 — the model needs the real error
        return successes, done, f"{type(exc).__name__}: {exc}"
    return successes, done, None


def verify_combinatorics(job: VerifyJob) -> VerifyOutcome:
    """Count the objects directly and compare with the claimed number."""
    claimed_text = job.text("value", "count", "result", "n")
    try:
        claimed = int(sympy.N(parse_math(claimed_text, what="the claimed count")))
    except (TypeError, ValueError):
        return outcome(
            job,
            "error",
            method="direct enumeration",
            detail=f"the claimed count {claimed_text!r} is not an integer.",
        )

    space_code = job.text("space", "candidates", "universe", "enumerate")
    predicate_code = job.text("predicate", "condition", "filter", default="True")
    if not space_code:
        return outcome(
            job,
            "inconclusive",
            method="direct enumeration",
            detail=(
                "No sample space was supplied, so nothing can be counted "
                "independently. Provide `space`: a Python expression producing an "
                "iterable of every candidate, and `predicate`: an expression in `x` "
                "that is True for the ones that count."
            ),
        )

    if mentions_literal(space_code, claimed_text) or mentions_literal(
        predicate_code, claimed_text
    ):
        return outcome(
            job,
            "inconclusive",
            method="direct enumeration",
            detail=(
                "The enumeration references the claimed count itself, so running it "
                "would confirm the answer with the answer. Describe the objects, not "
                "the total."
            ),
        )

    try:
        space_compiled = compile_expression(space_code, "space")
        predicate_compiled = compile_expression(predicate_code, "predicate")
    except SandboxError as exc:
        return outcome(job, "error", method="direct enumeration", detail=str(exc))

    namespace = _rng_namespace(job.seed)
    try:
        space = eval(space_compiled, namespace)  # noqa: S307 — closed namespace
        counted = count_matching(
            space,
            lambda item: bool(eval(predicate_compiled, namespace, {"x": item})),  # noqa: S307
            MAX_ENUMERATION,
        )
    except ValueError as exc:
        return outcome(
            job,
            "partial",
            method="direct enumeration",
            detail=(
                f"The sample space is too large to enumerate ({exc}). The claim was "
                "not checked against a listing of the objects."
            ),
        )
    except Exception as exc:  # noqa: BLE001
        return outcome(
            job,
            "error",
            method="direct enumeration",
            detail=f"the enumeration failed — {type(exc).__name__}: {exc}",
        )

    ok = counted == claimed
    return outcome(
        job,
        "verified" if ok else "refuted",
        method="enumerated the sample space and counted the objects satisfying the condition",
        detail=(
            f"Direct enumeration finds exactly {counted} objects, matching the claim."
            if ok
            else f"Direct enumeration finds {counted} objects, not {claimed}."
        ),
        symbolic=SymbolicCheck(
            ok=ok, detail=f"enumerated count = {counted}, claimed = {claimed}"
        ),
        counterexample=None if ok else {"enumerated": str(counted), "claimed": str(claimed)},
    )
