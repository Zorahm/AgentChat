/** TEMPORARY debug harness for visually verifying the verification badge and
 *  the plot card. Not part of the app — rendered only behind ?debug-math.
 *
 *  All five badge states appear at once, which is the only way to check the
 *  thing that actually matters: that they are told apart at a glance. A design
 *  where `inconclusive` reads as a pass, or `error` reads as a failure, looks
 *  perfectly fine one state at a time.
 *
 *  State is built by replaying real tool_progress events through the reducers,
 *  so what renders here is exactly what a live run produces. */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { MathPlotCard } from "./components/Chat/MathPlotCard";
import { VerificationBadge } from "./components/Chat/VerificationBadge";
import type { ToolCall } from "./types/tool-call";
import { applyMathPlotEvent, emptyMathPlot } from "./utils/mathPlot";
import { applyVerifyEvent, emptyVerification } from "./utils/verification";

function outcome(over: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "verified",
    kind: "root",
    problem: "x^2 - 5x + 6 = 0",
    claim: { equation: "x**2 - 5*x + 6 = 0", variable: "x", roots: ["2", "3"] },
    symbolic: { ok: true, detail: "substitution vanishes; solution set matches" },
    numeric: { ok: true, max_abs_err: 0, max_rel_err: 0, samples: 96, detail: "sampled 96 real points" },
    detail: "All 2 claimed roots substitute to zero, and the solution set is complete.",
    method: "substituted each claimed root for x in the original equation",
    verifier: "deterministic",
    attempt: 1,
    seed: 42,
    duration_ms: 51,
    ...over,
  };
}

function badge(id: string, events: Record<string, unknown>[]): ToolCall {
  let verify = emptyVerification(Date.now());
  for (const event of events) verify = applyVerifyEvent(verify, event);
  return { id, name: "math_verify", input: {}, status: "success", verify };
}

const START = { kind: "start", verifyKind: "root", problem: "x^2 - 5x + 6 = 0", attempt: 1, messageId: "dbg" };

const CALLS: ToolCall[] = [
  badge("v1", [START, { kind: "verdict", outcome: outcome({}) }]),
  badge("v2", [
    START,
    {
      kind: "verdict",
      outcome: outcome({
        status: "refuted",
        detail: "1 of 2 claimed roots does not satisfy the equation — the residual is not zero.",
        symbolic: { ok: false, detail: "substitution left a non-zero residual" },
        numeric: { ok: false, max_abs_err: 2, max_rel_err: 0.167, samples: 96, detail: "sampled 96 real points" },
        counterexample: { failing_roots: [{ root: "4", residual: "2" }] },
      }),
    },
  ]),
  badge("v3", [
    START,
    {
      kind: "verdict",
      outcome: outcome({
        status: "partial",
        kind: "inequality",
        problem: "x^2 - 2x + 3 > 0 on [-5, 5]",
        detail:
          "No counterexample was found at any sampled point, on the boundary, or at an interior critical point. That is evidence, not a proof.",
        symbolic: undefined,
      }),
    },
  ]),
  badge("v4", [
    START,
    {
      kind: "verdict",
      outcome: outcome({
        status: "inconclusive",
        kind: "proof",
        problem: "Prove that sqrt(2) is irrational",
        detail: "A proof is not machine-checkable here.",
        symbolic: undefined,
        numeric: undefined,
      }),
    },
  ]),
  badge("v5", [
    START,
    {
      kind: "verdict",
      outcome: outcome({
        status: "error",
        detail:
          "the verifier failed: the calculation exceeded its 25s budget and was stopped. This says nothing about whether the answer is right.",
        symbolic: undefined,
        numeric: undefined,
      }),
    },
  ]),
  // The case the whole two-attempt rule exists for: refuted, rewritten, passed —
  // with the first attempt still on the record underneath.
  badge("v6", [
    START,
    {
      kind: "verdict",
      outcome: outcome({
        status: "refuted",
        detail: "The claimed antiderivative differentiates to something else.",
        counterexample: { x: "1.234", residual: "0.918" },
      }),
    },
    { kind: "verdict", outcome: outcome({ attempt: 2, duration_ms: 33 }) },
  ]),
  badge("v7", [START]),
];

const PLOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 460" width="100%">
  <rect x="0" y="0" width="760" height="460" fill="var(--bg, transparent)"/>
  <line x1="62" y1="230" x2="736" y2="230" stroke="var(--axis, rgba(128,128,128,.55))" stroke-width="1.4"/>
  <path d="M62 230 Q 230 40 398 230 T 736 230" fill="none" stroke="var(--chart-1, #4f9dde)" stroke-width="2"/>
  <text x="62" y="24" fill="var(--fg, #1c1c1c)" font-size="14" font-weight="600">sin(x) on [-6, 6]</text>
</svg>`;

function plot(id: string, events: Record<string, unknown>[]): ToolCall {
  let data = emptyMathPlot(Date.now());
  for (const event of events) data = applyMathPlotEvent(data, event);
  return { id, name: "math_plot", input: {}, status: "success", plot: data };
}

const PLOTS: ToolCall[] = [
  plot("p1", [
    { kind: "start", plotKind: "cartesian", exprs: ["sin(x)"], title: "sin(x) on [-6, 6]" },
    { kind: "svg", svg: PLOT_SVG, title: "sin(x) on [-6, 6]", warnings: [] },
  ]),
  plot("p2", [{ kind: "start", plotKind: "cartesian", exprs: ["sin(x)"], title: "" }]),
  plot("p3", [
    { kind: "start", plotKind: "cartesian", exprs: ["log(x)"], title: "" },
    { kind: "failed", message: "nothing was drawable — the expression has no finite values in the requested range." },
  ]),
];

export function DebugMathHarness() {
  return (
    <Theme theme={neutralTheme}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 style={{ font: "600 15px/1.4 system-ui", margin: "0 0 8px" }}>
          Verification badges — all five states, plus a rewrite and a pending check
        </h2>
        {CALLS.map((call) => (
          <VerificationBadge key={call.id} call={call} chatId="debug" />
        ))}

        <h2 style={{ font: "600 15px/1.4 system-ui", margin: "24px 0 8px" }}>Plot cards</h2>
        {PLOTS.map((call) => (
          <MathPlotCard key={call.id} call={call} />
        ))}
      </div>
    </Theme>
  );
}
