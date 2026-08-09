/** TEMPORARY debug harness for visually verifying the image_generate card.
 * Not part of the app — rendered only behind ?debug-images, since a real run
 * needs a GPU or a paid image API. Builds its state by replaying real
 * tool_progress events through the reducer, so what you see is exactly what a
 * live render would produce.
 *
 * The tiles load through the backend's /files/serve, so point IMAGE_PATHS at
 * two real files on this machine before using it. */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { ImageGenCard } from "./components/Chat/ImageGenCard";
import type { ToolCall } from "./types/tool-call";
import { applyImageEvent, closeImageGen, emptyImageGen } from "./utils/imageGen";

const IMAGE_PATHS = [
  "C:\\Users\\ZorahM\\AppData\\Local\\Temp\\claude\\D--AgentChat\\eb4c1285-0638-447e-b4c2-45fc497ea71d\\scratchpad\\imgs\\sunset.png",
  "C:\\Users\\ZorahM\\AppData\\Local\\Temp\\claude\\D--AgentChat\\eb4c1285-0638-447e-b4c2-45fc497ea71d\\scratchpad\\imgs\\waves.png",
];

// Long on purpose: the card must show the whole thing. A model writing a real
// prompt produces something this size, and clamping it hid what was rendered.
const PROMPT =
  "A lighthouse on a basalt cliff at sunset, long exposure, low golden light raking " +
  "across wet rock, seabirds circling, heavy clouds breaking on the horizon, 35mm film " +
  "grain, muted teal and amber palette, shot on Portra 400, shallow depth of field";

const INPUT: Record<string, unknown> = {
  prompt: PROMPT,
  negative_prompt: "blurry, watermark, text, extra fingers",
  steps: 30,
  cfg_scale: 6.5,
};

function build(events: Record<string, unknown>[], status: ToolCall["status"] = "running"): ToolCall {
  let data = emptyImageGen(Date.now() - 18_000);
  for (const event of events) data = applyImageEvent(data, event);
  return { id: `dbg-${events.length}-${status}`, name: "image_generate", input: INPUT, status, image: data };
}

const start = { kind: "start", backend: "a1111", prompt: PROMPT, count: 2 };
const image = (i: number) => ({
  kind: "image",
  path: IMAGE_PATHS[i],
  index: i,
  width: 512,
  height: 512,
  seed: 1234567 + i,
});

const queued = build([start, { kind: "progress", status: "queued (1 ahead)" }]);
const rendering = build([start, { kind: "progress", percent: 42, status: "11/25" }]);
const halfway = build([start, { kind: "progress", percent: 78, status: "20/25" }, image(0)]);
const done = build([start, image(0), image(1), { kind: "done" }], "success");
const single = build(
  [{ kind: "start", backend: "api", prompt: PROMPT, count: 1 }, image(0), { kind: "done" }],
  "success",
);
// Closed the way a real turn closes it: the tool returned "Error: …" as an
// ordinary string, so tool_end reports success. The card must still show the
// failure — see tests/ui/src/image_gen.ts.
const failed = ((): ToolCall => {
  const call = build(
    [start, { kind: "failed", message: "ComfyUI failed in node KSampler: CUDA out of memory" }, { kind: "done" }],
    "success",
  );
  return { ...call, image: closeImageGen(call.image!, true, "Error: CUDA out of memory", 900) };
})();

const diedSilently = ((): ToolCall => {
  const call = build([start], "success");
  return {
    ...call,
    id: "dbg-silent",
    image: closeImageGen(call.image!, true, "Error: Stable Diffusion WebUI is unreachable", 300),
  };
})();

/** A chat saved before this field existed must render, not throw. */
const legacy = {
  id: "dbg-legacy",
  name: "image_generate",
  input: { prompt: PROMPT },
  status: "success",
  image: { startedAt: Date.now() },
} as unknown as ToolCall;

/** A chat saved before the arguments carried anything but the prompt. */
const noArgs = {
  id: "dbg-noargs",
  name: "image_generate",
  input: {},
  status: "success",
  image: { ...single.image!, prompt: "a short prompt from the event only" },
} as unknown as ToolCall;

export function DebugImageHarness() {
  return (
    <Theme theme={neutralTheme}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
        <h2>Queued (indeterminate)</h2>
        <ImageGenCard call={queued} />

        <h2>Rendering (42%)</h2>
        <ImageGenCard call={rendering} />

        <h2>One of two landed</h2>
        <ImageGenCard call={halfway} />

        <h2>Complete — two images</h2>
        <ImageGenCard call={done} />

        <h2>Complete — single image</h2>
        <ImageGenCard call={single} />

        <h2>Failed</h2>
        <ImageGenCard call={failed} />

        <h2>Died without saying why</h2>
        <ImageGenCard call={diedSilently} />

        <h2>Legacy chat (no fields)</h2>
        <ImageGenCard call={legacy} />

        <h2>Prompt from the event only (no saved arguments)</h2>
        <ImageGenCard call={noArgs} />
      </div>
    </Theme>
  );
}
