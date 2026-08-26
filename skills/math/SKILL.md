---
name: math
description: "Read this for any mathematical question — arithmetic, algebra, geometry, calculus, probability, statistics, linear algebra, discrete maths, number theory, numerical methods, proofs, or plotting a function. Triggers include 'solve', 'compute', 'evaluate', 'find x', 'prove', 'differentiate', 'integrate', 'simplify', 'what is the probability', 'how many ways', 'plot', 'graph', 'вычисли', 'реши', 'найди', 'докажи', 'постройграфик'. It defines how a solution is laid out, when each maths tool must be called, and what the verification statuses mean. Do NOT use it for general programming, data processing, or spreadsheet work that merely contains numbers."
version: "1.0.0"
author: AgentChat
---

# Mathematics

Three things go wrong when a chat model does maths, and this skill exists to
close all three:

1. **A plausible wrong answer.** Confident, well-formatted, and incorrect, with
   nothing to check it against.
2. **A solution that dissolves into paragraphs.** No structure, formulas half in
   LaTeX and half in words.
3. **A graph described instead of drawn.**

## The shape of an answer

Every non-trivial problem gets this structure. Not a suggestion — without it the
answer drifts back into prose by the third message.

```
**Дано.** / **Given.**      the problem restated strictly, in LaTeX
**Найти.** / **Find.**      exactly what is being asked for
**Решение.** / **Solution.** numbered steps; one transformation per step, with its justification
**Ответ.** / **Answer.**    a set-off block containing the result and nothing else
**Проверка.** / **Check.**  what was verified, how, and the status that came back
```

Write the headings in the user's language. Skip **Дано/Найти** only for a
genuinely one-line question ("what is 15% of 240?"); never skip **Ответ**.

## Notation

- Every expression is LaTeX: `$…$` inline, `$$…$$` for display. Never "the
  integral from a to b of f of x" — write `$\int_a^b f(x)\,dx$`.
- Define each symbol you introduce, on first use.
- Give exact values first, decimals second: `$\frac{\pi}{6} \approx 0.5236$`.
- Units belong with the number, in the formula and in the answer.

## The tools, and when each is required

### `math_verify` — required on every final answer

Call it once your answer is settled, on the **final** claim, before you present
it. Not on intermediate steps.

It never sees your solution — only the problem and the claim — so it can
genuinely disagree with you. That is the point: a checker that reads your
reasoning first will agree with your reasoning, including the error in it.

Pick the `kind` that matches what you actually assert:

| Claim | `kind` | How it gets checked |
|---|---|---|
| "the roots are …" | `root` | substituted back in; completeness checked separately |
| "A ≡ B" | `identity` | `simplify(A−B)` **and** sampled numerically |
| "f′ = g" | `derivative` | differentiated by CAS and compared |
| "∫f = F + C" | `integral_indef` | **F is differentiated** — the reverse path |
| "∫ₐᵇ f = c" | `integral_def` | independent numeric quadrature |
| "lim = L" | `limit` | CAS limit plus a two-sided approach sequence |
| "Σ = S" | `sum` | closed form plus accelerated numeric summation |
| "x solves Ax=b", "v is an eigenvector" | `linalg` | direct substitution: `A·x−b`, `A·v−λ·v` |
| "P = p" | `probability` | **Monte Carlo** — you supply the experiment |
| "there are n ways" | `combinatorics` | **direct enumeration** — you supply the sample space |
| "the inequality holds on D" | `inequality` | sampling, boundary, critical points, solution set |
| a proof, a construction | `proof` / `other` | not machine-checkable → `inconclusive`, honestly |

**`problem` is the weak link.** The claim is checked against the statement you
hand over, so a problem restated loosely — or "helpfully" simplified — verifies
the wrong question and still comes back green. Restate the user's actual
question, and nothing else. The user sees this string next to the badge.

**`probability` and `combinatorics` carry their weight only if you write a real
experiment.** Give `trial` as a Python expression that plays out one round of
the random process using `rng` / `randint` / `choice` and evaluates to `True` on
success; give `space` as an expression enumerating every candidate and
`predicate` as a condition on `x`. Code that mentions the answer you are
claiming is refused outright — and rightly, since simulating your own answer
proves nothing.

### What the statuses mean

- **`verified`** — the reverse substitution closed. Say briefly in your answer
  what was checked and how. Don't just write "verified".
- **`refuted`** — you are wrong. Read the counterexample, find where your method
  breaks, redo the solution and verify once more. **One retry, never two.** If
  the second attempt is refuted as well, stop: tell the user plainly that you
  could not solve it, and show both counterexamples. Do not hide the first
  attempt.
- **`partial`** — part of it holds. Say exactly which part is established and
  which is not. This is not a pass.
- **`inconclusive`** — nothing here was machine-checkable. Do not claim you
  verified anything. Mention that the user can press **Re-check** for an
  independent verifier.
- **`error`** — the checker itself failed. This is **not** evidence about your
  answer. Never rewrite a correct solution because of it; say the check was
  unavailable and move on.

### `math_eval` — the arithmetic, not the reasoning

`sympy` (`sp`), `numpy` (`np`), `mpmath`, `math`, `random`, `itertools` and
`fractions` are preloaded; imports are refused and unnecessary. Use it for
anything you would otherwise do in your head and get wrong: evaluating a messy
expression, checking a coefficient, tabulating values.

**Never hand its output over as the solution.** "I called `sympy.solve()` and
the roots are 2 and 3" is a bad answer even though the roots are right. The
steps have to be human ones — a substitution, a factorisation, a named theorem.
`sympy` verifies and does the drudgery; it does not do the explaining.

### `math_plot` — draw it, don't describe it

Any time the answer involves shape, behaviour or comparison, draw it: `kind`
`cartesian`, `parametric`, `polar`, `implicit`, `field`, `surface` or
`discrete`. Mark what matters with `annotations` — roots and extrema as
`point`, asymptotes as `vline`, a definite integral as `area`, a derivative at a
point as `tangent`.

Use `show_widget` instead for what a function plot cannot express: a geometric
construction, an animated convergence, an interactive ε–δ illustration.

## Working the problem

- Choose the method before computing, and say which one and why. "By parts,
  taking $u = x$" is worth more than three lines of correct algebra with no
  reason given.
- One transformation per step. A step nobody can follow is not a step.
- State the domain, and the conditions under which each transformation is
  valid — squaring both sides, dividing by an expression that may vanish,
  swapping a limit with a sum.
- Check the answer's plausibility before verifying it formally: sign,
  magnitude, units, limiting cases. A probability outside [0,1] or a negative
  length is caught here for free.
- When the problem is genuinely ambiguous in a way that changes the answer, ask
  one `ask_user` question with concrete options rather than solving a guess.

## What this skill will not do

- It does not solve olympiad problems by asserting a result and verifying it.
  The verifier checks answers; it does not supply them.
- It does not prove theorems automatically. A proof comes back `inconclusive`,
  and that is the honest status — write the proof properly and let the reader
  check it.
- It is not a CAS front-end. If the user wants raw `sympy`, they can ask for it.
