/** Regression suite for the image_generate card's state.
 *
 * The bug this guards: `image_generate`, like every tool in this app, never
 * raises into the agent loop — it catches its own failures and returns
 * "Error: …" as an ordinary result. So `tool_end` reports **success: true** for
 * a render that produced nothing. The first version of the tool_end handler
 * trusted that flag, flipped a card the progress events had already marked
 * `failed` back to `complete`, and dropped the message with it. The user got an
 * empty card and no reason — which is how a Forge instance running without
 * `--api` looked like nothing at all had happened.
 *
 * So the rule these cases pin down: the progress events decide whether a render
 * failed; `tool_end` only settles what they left open. */

import {
  applyImageEvent,
  closeImageGen,
  emptyImageGen,
  imageCopyText,
  imageNegativePrompt,
  imagePrompt,
} from "../../../ui/src/utils/imageGen";
import type { ImageGenData, ToolCall } from "../../../ui/src/types/tool-call";
import { assert, report, section, test } from "./assert";

const START = { kind: "start", backend: "a1111", prompt: "a fox", count: 1 };
const IMAGE = { kind: "image", path: "/chats/c1/images/fox.png", index: 0, width: 512, height: 512, seed: 7 };

/** Replay a run's events, as useChats does on each tool_progress. */
function replay(...events: Record<string, unknown>[]): ImageGenData {
  let data = emptyImageGen(0);
  for (const event of events) data = applyImageEvent(data, event);
  return data;
}

section("Image card state");

test("a failed render survives a 'successful' tool_end", () => {
  const failed = replay(START, { kind: "failed", message: "API is switched off" }, { kind: "done" });
  // success=true is what the loop actually reports here — the tool returned a
  // string rather than raising.
  const closed = closeImageGen(failed, true, "Error: API is switched off", 120);
  assert(closed.status === "failed", `expected failed, got ${closed.status}`);
  assert(closed.error === "API is switched off", `lost the message: ${closed.error}`);
});

test("the done event cannot overwrite a failure either", () => {
  const data = replay(START, { kind: "failed", message: "boom" }, { kind: "done" });
  assert(data.status === "failed", `expected failed, got ${data.status}`);
});

test("a run that produced no image is a failure, whatever the flag says", () => {
  // The tool died between events (killed backend, crash) — nothing said
  // "failed", but an empty card claiming success is a lie.
  const closed = closeImageGen(replay(START), true, "Error: connection reset", 90);
  assert(closed.status === "failed", `expected failed, got ${closed.status}`);
  assert(closed.error === "Error: connection reset", `expected the output as the error, got ${closed.error}`);
});

test("a real render completes", () => {
  const closed = closeImageGen(replay(START, IMAGE, { kind: "done" }), true, "Generated 1 image", 4200);
  assert(closed.status === "complete", `expected complete, got ${closed.status}`);
  assert(closed.images.length === 1, "the image should survive");
  assert(closed.durationMs === 4200, "duration should be recorded");
});

test("stopping a run is not reported as a failure", () => {
  const cancelled: ImageGenData = { ...replay(START), status: "cancelled" };
  const closed = closeImageGen(cancelled, false, "", 50);
  assert(closed.status === "cancelled", `expected cancelled, got ${closed.status}`);
});

test("a duplicate image event does not double the grid", () => {
  // A resumed stream can redeliver events; the same file must appear once.
  const data = replay(START, IMAGE, IMAGE);
  assert(data.images.length === 1, `expected 1 image, got ${data.images.length}`);
});

test("a chat saved before this tool existed still renders", () => {
  const legacy = { startedAt: 0 } as unknown as ImageGenData;
  const closed = closeImageGen(legacy, true, "", 0);
  assert(Array.isArray(closed.images), "images must always be an array");
});

section("Prompt transparency");

/** A call as the UI holds it: the model's arguments plus the replayed events. */
function call(input: Record<string, unknown>, ...events: Record<string, unknown>[]): ToolCall {
  return {
    id: "c1",
    name: "image_generate",
    input,
    status: "success",
    image: replay(START, ...events),
  };
}

test("the prompt comes from the arguments, not the truncated event", () => {
  // The start event caps the prompt at 400 chars to keep the stream small;
  // showing that shortened copy would misrepresent what was rendered.
  const long = "a ".repeat(300).trim();
  const shown = imagePrompt(call({ prompt: long }, { kind: "start", prompt: long.slice(0, 400) }));
  assert(shown === long, `expected the full prompt, got ${shown.length} chars`);
});

test("an old chat with no arguments still shows what it has", () => {
  const shown = imagePrompt(call({}, { kind: "start", prompt: "a fox" }));
  assert(shown === "a fox", `expected the event's prompt, got ${shown}`);
});

test("the negative prompt is surfaced, not silently applied", () => {
  assert(imageNegativePrompt(call({ negative_prompt: " blurry " })) === "blurry", "expected it trimmed");
  assert(imageNegativePrompt(call({})) === "", "expected empty when unset");
});

test("copy produces a reproducible render in A1111 paste format", () => {
  const tc = call({ prompt: "a fox", negative_prompt: "blurry", steps: 30, cfg_scale: 6.5 }, IMAGE);
  const lines = imageCopyText(tc).split("\n");
  assert(lines[0] === "a fox", `expected the prompt first, got ${lines[0]}`);
  assert(lines[1] === "Negative prompt: blurry", `unexpected line: ${lines[1]}`);
  // One comma-joined params line is what the WebUI's paste button parses.
  assert(lines[2] === "Steps: 30, CFG scale: 6.5, Size: 512x512, Seed: 7", `unexpected line: ${lines[2]}`);
});

test("copying a bare prompt adds no empty scaffolding", () => {
  assert(imageCopyText(call({ prompt: "a fox" })) === "a fox", "expected just the prompt");
});

test("a batch copies one seed, because that is what reproduces it", () => {
  // The WebUI's parser reads a single Seed value and a batch's seeds run
  // consecutively from it; a comma-separated list reproduces nothing.
  const second = { ...IMAGE, path: "/chats/c1/images/fox-2.png", index: 1, seed: 8 };
  const text = imageCopyText(call({ prompt: "a fox" }, IMAGE, second));
  assert(text.includes("Seed: 7"), `expected the first seed, got: ${text}`);
  assert(!text.includes("Seed: 7, 8"), `seeds must not be listed: ${text}`);
});

report("image_gen");
