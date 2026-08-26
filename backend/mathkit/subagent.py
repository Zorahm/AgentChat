"""The fallback verifier: a model that never sees the solution.

Reached in exactly two situations — the deterministic path returned
``inconclusive`` (a proof, a word problem, a claim that fits no kind), or the
user pressed **Re-check**. It costs a model call, so it is never wired into the
normal turn.

Its independence is structural, not promised. :func:`verify_with_subagent`
accepts a problem and a claim and has no parameter through which reasoning could
arrive, so there is no version of this function that accidentally shows the
verifier the working it is meant to be checking. That is the entire design: a
"verifier" that reads the solution first reliably agrees with it, and produces a
green badge that means nothing at all.

It gets ``math_eval`` — a verifier that cannot compute is reduced to opinion.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from mathkit.runner import MathWorkerError, MathWorkerPool
from schemas.math import DEFAULT_SEED, VerifyOutcome

# Enough calls to compute something and conclude; few enough that a confused
# verifier costs one round of tokens rather than a runaway.
MAX_ITERATIONS = 5

SYSTEM_PROMPT = """You are an independent verifier. You check other people's answers.

You are given a PROBLEM and a proposed FINAL ANSWER. You are deliberately NOT \
given the reasoning that produced it, and you must not ask for it. Your job is \
not to re-derive the answer the same way — it is to test whether this answer \
actually satisfies this problem.

Prefer the reverse direction wherever one exists:
- an equation's roots: substitute them back in, and ask whether the set is complete
- an antiderivative: differentiate it
- a claimed identity: test it at several concrete values
- a probability or a count: simulate or enumerate the situation
- a proof: check each step follows, and look for the gap rather than the conclusion

Use the math_eval tool for any arithmetic — do not do sums in your head.

When you are done, reply with ONE JSON object and nothing else:
{"status": "verified" | "refuted" | "partial" | "inconclusive",
 "method": "<one line: what you actually did to check it>",
 "detail": "<2-4 sentences of reasoning a reader can audit>",
 "counterexample": {<concrete values where it fails>} or null}

Status meanings, which are not interchangeable:
- verified: you checked it and it holds.
- refuted: you checked it and it fails. You MUST give a counterexample.
- partial: part of the claim holds and part is unestablished. Say which is which.
- inconclusive: you could not check it. This is an honest answer — use it rather \
than guessing "verified" when you have not actually established anything."""

_EVAL_TOOL = {
    "type": "function",
    "function": {
        "name": "math_eval",
        "description": (
            "Run Python with sympy (sp), numpy (np), mpmath, math, random and "
            "itertools preloaded. No imports. Returns stdout and the last "
            "expression's value."
        ),
        "parameters": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Python to run."}},
            "required": ["code"],
        },
    },
}


@dataclass(frozen=True)
class VerifierModel:
    """Where to send the verification call.

    A local mirror of research's ``ModelEndpoint`` rather than an import: this
    package is reached from the worker side of the app and must not start
    depending on the research stack for one dataclass.
    """

    model: str
    api_key: str | None = None
    api_base: str | None = None
    extra_headers: dict[str, str] | None = None


async def verify_with_subagent(
    *,
    llm: Any,
    endpoint: VerifierModel,
    pool: MathWorkerPool,
    kind: str,
    problem: str,
    claim: dict[str, Any],
    seed: int = DEFAULT_SEED,
    attempt: int = 1,
    metadata: dict[str, Any] | None = None,
) -> VerifyOutcome:
    """Run the independent verifier. Never raises — failure comes back as ``error``."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"PROBLEM:\n{problem.strip() or '(not stated)'}\n\n"
                f"CLAIMED ANSWER (kind: {kind}):\n"
                f"{json.dumps(claim, ensure_ascii=False, indent=2)}"
            ),
        },
    ]

    try:
        for _ in range(MAX_ITERATIONS):
            response = await llm.completion(
                model=endpoint.model,
                messages=messages,
                tools=[_EVAL_TOOL],
                metadata=metadata,
            )
            message = response.choices[0].message
            calls = getattr(message, "tool_calls", None) or []
            if not calls:
                return _parse(message.content or "", kind, problem, claim, seed, attempt)

            messages.append(
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            },
                        }
                        for call in calls
                    ],
                }
            )
            for call in calls:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": await _run_eval(pool, call.function.arguments),
                    }
                )

        return _outcome(
            kind,
            problem,
            claim,
            seed,
            attempt,
            "inconclusive",
            method="independent verifier",
            detail=(
                "The verifier used all of its steps without reaching a conclusion. "
                "Treat the answer as unchecked."
            ),
        )
    except Exception as exc:  # noqa: BLE001 — provider errors of every shape
        return _outcome(
            kind,
            problem,
            claim,
            seed,
            attempt,
            "error",
            method="independent verifier",
            detail=f"the verifier could not run — {type(exc).__name__}: {exc}"[:400],
        )


async def _run_eval(pool: MathWorkerPool, arguments: str) -> str:
    """Execute the verifier's math_eval call in the same sandbox the tool uses."""
    try:
        parsed = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return "Error: arguments were not valid JSON."
    try:
        result = await pool.submit("eval", {"code": str(parsed.get("code") or "")}, timeout=20.0)
    except MathWorkerError as exc:
        return f"Error: {exc}"

    parts = [str(result.get("stdout") or "").rstrip()]
    if result.get("result") is not None:
        parts.append(f"=> {result['result']}")
    if result.get("error"):
        parts.append(f"[error] {result['error']}")
    return "\n".join(p for p in parts if p) or "(no output)"


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def _parse(
    text: str,
    kind: str,
    problem: str,
    claim: dict[str, Any],
    seed: int,
    attempt: int,
) -> VerifyOutcome:
    """Read the verifier's JSON verdict.

    An unreadable reply is ``inconclusive``, never ``verified``: the one failure
    mode that must not exist here is a green badge produced by a parser giving
    the model the benefit of the doubt.
    """
    match = _JSON_BLOCK.search(text or "")
    if match is None:
        return _outcome(
            kind, problem, claim, seed, attempt, "inconclusive",
            method="independent verifier",
            detail="The verifier did not return a readable verdict, so nothing was established.",
        )
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return _outcome(
            kind, problem, claim, seed, attempt, "inconclusive",
            method="independent verifier",
            detail="The verifier's verdict was not valid JSON, so nothing was established.",
        )

    status = str(payload.get("status") or "").lower()
    if status not in ("verified", "refuted", "partial", "inconclusive"):
        status = "inconclusive"
    counterexample = payload.get("counterexample")
    if status == "refuted" and not isinstance(counterexample, dict):
        # A refutation without a witness is an assertion. Downgraded rather than
        # trusted — otherwise the automatic rewrite fires on a hunch.
        status = "partial"
        counterexample = None

    return _outcome(
        kind,
        problem,
        claim,
        seed,
        attempt,
        status,
        method=str(payload.get("method") or "independent verifier"),
        detail=str(payload.get("detail") or ""),
        counterexample=counterexample if isinstance(counterexample, dict) else None,
    )


def _outcome(
    kind: str,
    problem: str,
    claim: dict[str, Any],
    seed: int,
    attempt: int,
    status: str,
    *,
    method: str,
    detail: str,
    counterexample: dict[str, Any] | None = None,
) -> VerifyOutcome:
    return VerifyOutcome(
        status=status,  # type: ignore[arg-type]
        kind=kind,  # type: ignore[arg-type]
        problem=problem,
        claim=claim,
        detail=detail,
        method=method,
        counterexample=counterexample,
        verifier="subagent",
        attempt=attempt,
        seed=seed,
    )
