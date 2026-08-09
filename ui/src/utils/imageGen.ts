/** Reduce `image_generate` tool_progress events into the image card's state.
 *
 *  The mirror of backend/images/progress.py — a field added there has to be
 *  read here, nothing else keeps the two in step. Same shape as
 *  utils/research.ts: pure, immutable, and tolerant of a chat saved before a
 *  field existed. */

import type { GeneratedImageRef, ImageGenData, ToolCall } from "../types/tool-call";

/** The prompt exactly as the model wrote it.
 *
 *  Read from the call's arguments rather than the `start` event: the event
 *  truncates at 400 characters to keep the stream small, and a card that shows
 *  the user a shortened version of what was actually rendered is not
 *  transparent. The event is the fallback for a chat saved before the
 *  arguments were persisted. */
export function imagePrompt(call: ToolCall): string {
  const fromArgs = call.input?.prompt;
  if (typeof fromArgs === "string" && fromArgs.trim()) return fromArgs;
  return call.image?.prompt ?? "";
}

/** What the model asked the renderer to avoid — invisible until now. */
export function imageNegativePrompt(call: ToolCall): string {
  const raw = call.input?.negative_prompt;
  return typeof raw === "string" ? raw.trim() : "";
}

/** Everything about the render, in AUTOMATIC1111's own paste format.
 *
 *  That format is not arbitrary: pasting it into the WebUI's prompt box and
 *  pressing the ↙ button restores every parameter. So "copy" hands the user a
 *  reproducible render, not just a string. */
export function imageCopyText(call: ToolCall): string {
  const lines = [imagePrompt(call)];
  const negative = imageNegativePrompt(call);
  if (negative) lines.push(`Negative prompt: ${negative}`);

  const params = imageParams(call);
  const first = call.image?.images?.[0];
  if (first && first.width > 0) params.push(`Size: ${first.width}x${first.height}`);
  // Only the first seed: the WebUI's parser reads one value, and a batch's
  // seeds run consecutively from it — so the first one reproduces the batch,
  // while a comma-separated list reproduces nothing.
  const seed = (call.image?.images ?? []).map((i) => i.seed).find((s) => typeof s === "number");
  if (typeof seed === "number") params.push(`Seed: ${seed}`);

  if (params.length > 0) lines.push(params.join(", "));
  return lines.join("\n");
}

/** Sampler settings the model chose, when it chose any. */
export function imageParams(call: ToolCall): string[] {
  const params: string[] = [];
  const steps = call.input?.steps;
  if (typeof steps === "number") params.push(`Steps: ${steps}`);
  const cfg = call.input?.cfg_scale;
  if (typeof cfg === "number") params.push(`CFG scale: ${cfg}`);
  return params;
}

/** A fresh, empty run. */
export function emptyImageGen(startedAt: number): ImageGenData {
  return { status: "running", backend: "", prompt: "", count: 1, images: [], startedAt };
}

/** Fill in fields a chat saved before this tool existed doesn't have, so
 *  reloading an old chat never blanks the card or throws on a missing array. */
export function normalizeImageGen(data: ImageGenData): ImageGenData {
  if (data.images && data.status) return data;
  return {
    ...data,
    status: data.status ?? "complete",
    images: data.images ?? [],
    count: data.count ?? 1,
    backend: data.backend ?? "",
    prompt: data.prompt ?? "",
    startedAt: data.startedAt ?? 0,
  };
}

/** Apply one structured tool_progress event onto the state (immutable). */
export function applyImageEvent(
  data: ImageGenData,
  event: Record<string, unknown>,
): ImageGenData {
  const state = normalizeImageGen(data);

  switch (String(event.kind ?? "")) {
    case "start":
      return {
        ...state,
        status: "running",
        backend: String(event.backend ?? "") || state.backend,
        prompt: String(event.prompt ?? "") || state.prompt,
        count: readCount(event.count) ?? state.count,
      };
    case "progress":
      return {
        ...state,
        percent: readPercent(event.percent),
        statusText: String(event.status ?? "") || undefined,
      };
    case "image": {
      const image = readImage(event);
      if (!image) return state;
      // Re-delivery of the same path (a resumed stream) must not duplicate it.
      if (state.images.some((i) => i.path === image.path)) return state;
      return { ...state, images: [...state.images, image] };
    }
    case "failed":
      return { ...state, status: "failed", error: String(event.message ?? "") };
    case "done":
      // `done` fires in a finally block, so it also follows a failure — it must
      // never overwrite the error status the card needs to show.
      return state.status === "failed"
        ? state
        : { ...state, status: "complete", percent: 100, statusText: undefined };
    default:
      return state;
  }
}

/** Settle the card when the tool call ends.
 *
 *  `success` is NOT the authority on whether the render worked. Tools never
 *  raise into the agent loop — `image_generate` catches its own failures and
 *  returns "Error: …" as an ordinary result — so `tool_end` reports success for
 *  a run that produced nothing. Trusting it here flipped a card that had
 *  already been told `failed` back to `complete` and discarded the message,
 *  leaving an empty card and no explanation.
 *
 *  So a `failed` event wins, and a "successful" call that produced no image is
 *  a failure too — that is the case where the tool died without emitting
 *  anything (a killed backend, a crash between events). */
export function closeImageGen(
  data: ImageGenData,
  success: boolean,
  output: string,
  durationMs: number,
): ImageGenData {
  const state = normalizeImageGen(data);
  // A user who pressed Stop is not looking at a failure.
  if (state.status === "cancelled") return { ...state, durationMs };
  const failed = state.status === "failed" || !success || state.images.length === 0;
  if (!failed) return { ...state, status: "complete", durationMs };
  return {
    ...state,
    status: "failed",
    durationMs,
    error: state.error || output || undefined,
  };
}

function readCount(raw: unknown): number | undefined {
  return typeof raw === "number" && raw > 0 ? Math.min(8, Math.round(raw)) : undefined;
}

function readPercent(raw: unknown): number | undefined {
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  return Math.max(0, Math.min(100, raw));
}

function readImage(event: Record<string, unknown>): GeneratedImageRef | null {
  const path = String(event.path ?? "");
  if (!path) return null;
  const seed = event.seed;
  return {
    path,
    width: typeof event.width === "number" ? event.width : 0,
    height: typeof event.height === "number" ? event.height : 0,
    ...(typeof seed === "number" ? { seed } : {}),
  };
}
