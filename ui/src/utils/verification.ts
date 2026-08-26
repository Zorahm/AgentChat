/** Reduce `math_verify` tool_progress events into the badge's state.
 *
 *  The mirror of backend/mathkit/progress.py — a field added there has to be
 *  read here, nothing else keeps the two in step. Same shape as utils/imageGen.ts:
 *  pure, immutable, and tolerant of a chat saved before a field existed.
 *
 *  The verdict travels as structured events rather than being parsed out of the
 *  tool's text output on purpose. The model reads a sentence; the badge needs
 *  the status, both check halves, the counterexample and the problem the claim
 *  was checked against — and recovering those from prose is how the two drift.
 */

import type {
  VerificationData,
  VerifierKind,
  VerifyAttempt,
  VerifyNumeric,
  VerifyStatus,
  VerifySymbolic,
  ToolCall,
} from "../types/tool-call";

const STATUSES: readonly VerifyStatus[] = [
  "verified",
  "refuted",
  "partial",
  "inconclusive",
  "error",
];

export function emptyVerification(startedAt: number): VerificationData {
  return { status: "running", kind: "", problem: "", attempts: [], startedAt };
}

/** Fill in fields absent from a chat saved before they existed. */
export function normalizeVerification(data: VerificationData): VerificationData {
  if (data.attempts) return data;
  return { ...data, attempts: [], kind: data.kind ?? "", problem: data.problem ?? "" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStatus(value: unknown): VerifyStatus {
  const text = String(value ?? "");
  // Anything unrecognised becomes `error`, never `verified`. An unknown status
  // is a version mismatch, and the one failure this badge must not have is a
  // green light produced by a parser being generous.
  return (STATUSES as readonly string[]).includes(text) ? (text as VerifyStatus) : "error";
}

function asSymbolic(value: unknown): VerifySymbolic | undefined {
  const raw = asRecord(value);
  if (!("ok" in raw)) return undefined;
  return { ok: Boolean(raw.ok), detail: String(raw.detail ?? "") };
}

function asNumeric(value: unknown): VerifyNumeric | undefined {
  const raw = asRecord(value);
  if (!("ok" in raw)) return undefined;
  return {
    ok: Boolean(raw.ok),
    maxAbsErr: Number(raw.max_abs_err ?? 0),
    maxRelErr: Number(raw.max_rel_err ?? 0),
    samples: Number(raw.samples ?? 0),
    detail: String(raw.detail ?? ""),
  };
}

/** One serialised `VerifyOutcome` → the shape the badge renders. */
export function readOutcome(value: unknown): VerifyAttempt {
  const raw = asRecord(value);
  const counterexample = asRecord(raw.counterexample);
  const verifier = String(raw.verifier ?? "deterministic");
  return {
    status: asStatus(raw.status),
    kind: String(raw.kind ?? ""),
    problem: String(raw.problem ?? ""),
    claim: asRecord(raw.claim),
    symbolic: asSymbolic(raw.symbolic),
    numeric: asNumeric(raw.numeric),
    counterexample: Object.keys(counterexample).length > 0 ? counterexample : undefined,
    detail: String(raw.detail ?? ""),
    method: String(raw.method ?? ""),
    verifier: (verifier === "subagent" ? "subagent" : "deterministic") as VerifierKind,
    attempt: Number(raw.attempt ?? 1),
    seed: Number(raw.seed ?? 42),
    durationMs: Number(raw.duration_ms ?? 0),
  };
}

/** Apply one structured tool_progress event onto the state (immutable). */
export function applyVerifyEvent(
  data: VerificationData,
  event: Record<string, unknown>,
): VerificationData {
  const state = normalizeVerification(data);

  switch (String(event.kind ?? "")) {
    case "start":
      return {
        ...state,
        status: "running",
        kind: String(event.verifyKind ?? state.kind),
        problem: String(event.problem ?? state.problem),
        messageId: String(event.messageId ?? state.messageId ?? ""),
      };
    case "verdict": {
      const outcome = readOutcome(event.outcome);
      // Appended, never replaced. A refuted first attempt followed by a
      // verified second one is the honest history of the answer, and dropping
      // the first is precisely how a verification badge becomes decoration.
      return {
        ...state,
        status: "complete",
        kind: outcome.kind || state.kind,
        problem: outcome.problem || state.problem,
        attempts: [...state.attempts, outcome],
      };
    }
    case "failed":
      return { ...state, status: "failed", error: String(event.message ?? "") };
    default:
      return state;
  }
}

/** Settle the state when the tool call itself finishes. */
export function closeVerification(
  data: VerificationData,
  success: boolean,
  durationMs: number,
): VerificationData {
  const state = normalizeVerification(data);
  if (state.status === "running") {
    return {
      ...state,
      status: success && state.attempts.length > 0 ? "complete" : "failed",
      durationMs,
    };
  }
  return { ...state, durationMs };
}

/** The verdict the badge shows: the last attempt made.
 *
 *  The last rather than the best. When the second attempt is still refuted the
 *  badge stays red, and when the first was refuted and the second verified the
 *  badge goes green *with the earlier attempt still listed underneath* — which
 *  is the whole point of keeping both.
 */
export function latestAttempt(data: VerificationData): VerifyAttempt | undefined {
  const attempts = normalizeVerification(data).attempts;
  return attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
}

/** Every finished verification attached to one assistant message. */
export function collectVerifications(calls: ToolCall[] | undefined): ToolCall[] {
  return (calls ?? []).filter((c) => c.verify !== undefined);
}
