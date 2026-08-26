/** Regression suite for the verification badge's state.
 *
 * The reducer is where the badge's honesty lives. Three rules it has to keep,
 * each of which is a way for the badge to start lying if it doesn't:
 *
 *  - **Every attempt is kept.** A refuted first pass followed by a verified
 *    rewrite is the honest history of an answer. Replacing the first with the
 *    second turns the badge into theatre — the user sees a green tick and never
 *    learns the model got it wrong and had to redo it.
 *  - **An unknown status is `error`, never `verified`.** A frozen sidecar can
 *    predate the UI (AGENTS.md, "Don't forget step 2"), so an unrecognised
 *    string is a version mismatch. A parser being generous with it produces a
 *    green light nobody checked.
 *  - **`tool_end` only settles what the events left open.** Every tool in this
 *    app catches its own failures and returns "Error: …" as an ordinary result,
 *    so `success: true` arrives even when nothing was verified. */

import {
  applyVerifyEvent,
  closeVerification,
  emptyVerification,
  latestAttempt,
  readOutcome,
} from "../../../ui/src/utils/verification";
import type { VerificationData } from "../../../ui/src/types/tool-call";
import { assert, report, section, test } from "./assert";

const START = {
  kind: "start",
  verifyKind: "root",
  problem: "x^2 - 5x + 6 = 0",
  attempt: 1,
  messageId: "m1",
};

function outcome(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "verified",
    kind: "root",
    problem: "x^2 - 5x + 6 = 0",
    claim: { roots: ["2", "3"] },
    symbolic: { ok: true, detail: "substitution vanishes" },
    numeric: { ok: true, max_abs_err: 0, max_rel_err: 1e-15, samples: 96, detail: "96 points" },
    counterexample: null,
    detail: "All claimed roots substitute to zero.",
    method: "substitution",
    verifier: "deterministic",
    attempt: 1,
    seed: 42,
    duration_ms: 51,
    ...over,
  };
}

/** Replay a check's events, as useChats does on each tool_progress. */
function replay(...events: Record<string, unknown>[]): VerificationData {
  let data = emptyVerification(0);
  for (const event of events) data = applyVerifyEvent(data, event);
  return data;
}

section("Verification state");

test("a verdict lands with both check halves intact", () => {
  const state = replay(START, { kind: "verdict", outcome: outcome() });
  const attempt = latestAttempt(state);
  assert(state.status === "complete", `status ${state.status}`);
  assert(attempt?.status === "verified", "verdict not read");
  assert(attempt?.symbolic?.ok === true, "symbolic half lost");
  assert(attempt?.numeric?.samples === 96, "numeric half lost");
  assert(attempt?.numeric?.maxRelErr === 1e-15, "relative error lost");
});

test("both attempts survive a rewrite, in order", () => {
  const state = replay(
    START,
    { kind: "verdict", outcome: outcome({ status: "refuted", counterexample: { root: "4" } }) },
    { kind: "verdict", outcome: outcome({ attempt: 2 }) },
  );
  assert(state.attempts.length === 2, `kept ${state.attempts.length} attempts`);
  assert(state.attempts[0]?.status === "refuted", "the failed first attempt was dropped");
  assert(state.attempts[1]?.status === "verified", "the second attempt is missing");
});

test("the badge shows the last attempt, not the best one", () => {
  const state = replay(
    START,
    { kind: "verdict", outcome: outcome() },
    { kind: "verdict", outcome: outcome({ status: "refuted", attempt: 2 }) },
  );
  assert(latestAttempt(state)?.status === "refuted", "a later refutation was hidden");
});

test("an unknown status reads as error, never as verified", () => {
  const attempt = readOutcome(outcome({ status: "gloriously_true" }));
  assert(attempt.status === "error", `got ${attempt.status}`);
});

test("a missing status reads as error", () => {
  assert(readOutcome({}).status === "error", "an empty payload passed as something");
});

test("the problem the claim was checked against is carried through", () => {
  // The one thing a human can audit that no code can — a claim proven against a
  // reworded problem verifies cleanly and means nothing.
  const state = replay(START, { kind: "verdict", outcome: outcome() });
  assert(latestAttempt(state)?.problem === "x^2 - 5x + 6 = 0", "problem lost");
});

test("the message id rides along so Re-check files under the same turn", () => {
  assert(replay(START).messageId === "m1", "message id lost");
});

test("a counterexample survives, and an absent one does not become an empty object", () => {
  const refuted = readOutcome(outcome({ counterexample: { root: "4", residual: "2" } }));
  assert(refuted.counterexample?.root === "4", "counterexample lost");
  assert(readOutcome(outcome()).counterexample === undefined, "empty counterexample invented");
});

test("a failed check is a failure, whatever tool_end reports", () => {
  // The tool returns "Error: …" as an ordinary result, so success is true here.
  const failed = replay(START, { kind: "failed", message: "the worker died" });
  const closed = closeVerification(failed, true, 120);
  assert(closed.status === "failed", `status ${closed.status}`);
  assert(closed.error === "the worker died", "the reason was dropped");
});

test("a check that produced no verdict cannot close as complete", () => {
  const closed = closeVerification(replay(START), true, 120);
  assert(closed.status === "failed", `status ${closed.status}`);
});

test("tool_end does not overwrite a verdict already in hand", () => {
  const state = replay(START, { kind: "verdict", outcome: outcome({ status: "refuted" }) });
  const closed = closeVerification(state, false, 90);
  assert(closed.status === "complete", `status ${closed.status}`);
  assert(latestAttempt(closed)?.status === "refuted", "verdict lost on close");
});

test("an unrecognised event is ignored rather than corrupting the state", () => {
  const state = replay(START, { kind: "verdict", outcome: outcome() }, { kind: "from_the_future" });
  assert(state.attempts.length === 1, "an unknown event changed the attempts");
});

test("a chat saved before this tool existed still renders", () => {
  // No `attempts` array at all — the shape a tree written by an older build has.
  const legacy = { status: "complete", startedAt: 0 } as unknown as VerificationData;
  assert(latestAttempt(legacy) === undefined, "legacy state threw instead of degrading");
  const revived = applyVerifyEvent(legacy, { kind: "verdict", outcome: outcome() });
  assert(revived.attempts.length === 1, "legacy state could not take a new verdict");
});

test("the subagent verdict is distinguishable from the deterministic one", () => {
  const attempt = readOutcome(outcome({ verifier: "subagent" }));
  assert(attempt.verifier === "subagent", "verifier identity lost");
  assert(readOutcome(outcome({ verifier: "nonsense" })).verifier === "deterministic", "bad verifier not defaulted");
});

report("verification");
