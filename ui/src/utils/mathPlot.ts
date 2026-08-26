/** Reduce `math_plot` tool_progress events into the plot card's state.
 *
 *  The mirror of PlotProgressEmitter in backend/mathkit/progress.py. The SVG
 *  arrives through this channel rather than in the tool call's arguments
 *  because the backend draws it — the model only said what to draw, the same
 *  reason image_generate streams its paths. */

import type { MathPlotData, ToolCall } from "../types/tool-call";

export function emptyMathPlot(startedAt: number): MathPlotData {
  return { status: "running", plotKind: "", exprs: [], title: "", warnings: [], startedAt };
}

/** Fill in fields absent from a chat saved before they existed. */
export function normalizeMathPlot(data: MathPlotData): MathPlotData {
  if (data.exprs && data.warnings) return data;
  return {
    ...data,
    exprs: data.exprs ?? [],
    warnings: data.warnings ?? [],
    plotKind: data.plotKind ?? "",
    title: data.title ?? "",
  };
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** Apply one structured tool_progress event onto the state (immutable). */
export function applyMathPlotEvent(
  data: MathPlotData,
  event: Record<string, unknown>,
): MathPlotData {
  const state = normalizeMathPlot(data);

  switch (String(event.kind ?? "")) {
    case "start":
      return {
        ...state,
        status: "running",
        plotKind: String(event.plotKind ?? state.plotKind),
        exprs: asStrings(event.exprs),
        title: String(event.title ?? state.title),
      };
    case "svg":
      return {
        ...state,
        status: "complete",
        svg: String(event.svg ?? ""),
        title: String(event.title ?? state.title),
        warnings: asStrings(event.warnings),
      };
    case "failed":
      return { ...state, status: "failed", error: String(event.message ?? "") };
    default:
      return state;
  }
}

/** Settle the state when the tool call itself finishes. */
export function closeMathPlot(
  data: MathPlotData,
  success: boolean,
  durationMs: number,
): MathPlotData {
  const state = normalizeMathPlot(data);
  if (state.status === "running") {
    return { ...state, status: success && state.svg ? "complete" : "failed", durationMs };
  }
  return { ...state, durationMs };
}

/** Every rendered plot attached to one assistant message. */
export function collectPlots(calls: ToolCall[] | undefined): ToolCall[] {
  return (calls ?? []).filter((c) => c.plot !== undefined);
}
