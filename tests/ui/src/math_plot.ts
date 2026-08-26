/** Regression suite for the plot card's state.
 *
 * Same trap as the image card: `math_plot` catches its own failures and returns
 * "Error: …" as an ordinary tool result, so `tool_end` reports **success: true**
 * for a plot that produced nothing. Trusting that flag flips a card the progress
 * events already marked `failed` back to `complete`, and the user gets an empty
 * frame with no reason. */

import {
  applyMathPlotEvent,
  closeMathPlot,
  emptyMathPlot,
  normalizeMathPlot,
} from "../../../ui/src/utils/mathPlot";
import type { MathPlotData } from "../../../ui/src/types/tool-call";
import { assert, report, section, test } from "./assert";

const START = { kind: "start", plotKind: "cartesian", exprs: ["sin(x)"], title: "a wave" };
const SVG = { kind: "svg", svg: "<svg/>", title: "a wave", warnings: [] };

function replay(...events: Record<string, unknown>[]): MathPlotData {
  let data = emptyMathPlot(0);
  for (const event of events) data = applyMathPlotEvent(data, event);
  return data;
}

section("Plot card state");

test("a rendered plot completes with its markup", () => {
  const state = replay(START, SVG);
  assert(state.status === "complete", `status ${state.status}`);
  assert(state.svg === "<svg/>", "the SVG was dropped");
  assert(state.title === "a wave", "title lost");
  assert(state.exprs[0] === "sin(x)", "expressions lost");
});

test("a failed plot survives a 'successful' tool_end", () => {
  const failed = replay(START, { kind: "failed", message: "nothing was drawable" });
  const closed = closeMathPlot(failed, true, 300);
  assert(closed.status === "failed", `status ${closed.status}`);
  assert(closed.error === "nothing was drawable", "the reason was dropped");
});

test("a plot that never produced markup cannot close as complete", () => {
  const closed = closeMathPlot(replay(START), true, 300);
  assert(closed.status === "failed", `status ${closed.status}`);
});

test("warnings reach the card instead of being swallowed", () => {
  const state = replay(START, { ...SVG, warnings: ["tangent annotations need a cartesian plot"] });
  assert(state.warnings.length === 1, "warnings lost");
});

test("tool_end only records the duration once the plot is settled", () => {
  const closed = closeMathPlot(replay(START, SVG), true, 412);
  assert(closed.status === "complete", `status ${closed.status}`);
  assert(closed.durationMs === 412, "duration lost");
});

test("an unrecognised event leaves the state alone", () => {
  const state = replay(START, SVG, { kind: "from_the_future" });
  assert(state.svg === "<svg/>", "an unknown event clobbered the markup");
});

test("a chat saved before this tool existed still renders", () => {
  const legacy = { status: "complete", svg: "<svg/>", startedAt: 0 } as unknown as MathPlotData;
  const state = normalizeMathPlot(legacy);
  assert(Array.isArray(state.exprs) && state.exprs.length === 0, "legacy state threw");
  assert(Array.isArray(state.warnings), "warnings not defaulted");
});

report("math_plot");
