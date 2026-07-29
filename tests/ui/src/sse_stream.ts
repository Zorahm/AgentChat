/** Regression suite for the SSE reader (`ui/src/hooks/useSSE.ts`).
 *
 * The bug this guards: a chat's composer is disabled while its stream is live
 * (`disabled={state.isStreaming}` in ChatView), and `useChats` only clears that
 * flag from `dropStream`, which runs on the backend's `done`/`error` event or on
 * `onError`. If the connection just *ends* — sidecar restart, backend crash,
 * phone dropping the LAN/Tailscale link mid-reply — the reader loop finishes
 * normally, no terminal event ever arrives, and the chat stays "streaming"
 * forever: the user cannot type another message. Every case below pins down
 * which endings must report and which must stay silent. */

import { sseConnect, SSE_CLOSED_EARLY } from "../../../ui/src/hooks/useSSE";
import type { SSEEvent, SSEReader } from "../../../ui/src/hooks/useSSE";
import { assert, assertEqual, report, section, testAsync } from "./assert";

const CHAT_TERMINAL_EVENTS = ["done", "error"] as const;

/** Build a response body that emits `chunks` then closes. `signal` is wired to
 *  the stream so an abort surfaces the same AbortError the real fetch raises. */
function sseBody(chunks: readonly string[], signal: AbortSignal, keepOpen: boolean): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (keepOpen) {
        signal.addEventListener("abort", () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
        return;
      }
      controller.close();
    },
  });
}

interface StubOptions {
  readonly chunks: readonly string[];
  /** Leave the stream open after the chunks (so an abort can interrupt it). */
  readonly keepOpen?: boolean;
  readonly status?: number;
  readonly errorBody?: string;
}

function stubFetch(options: StubOptions): void {
  const impl = (_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
    const status = options.status ?? 200;
    if (status !== 200) {
      return Promise.resolve(new Response(options.errorBody ?? "", { status }));
    }
    const signal = init?.signal ?? new AbortController().signal;
    return Promise.resolve(new Response(sseBody(options.chunks, signal, options.keepOpen === true)));
  };
  globalThis.fetch = impl as unknown as typeof fetch;
}

interface Run {
  readonly events: SSEEvent[];
  readonly errors: Error[];
  readonly reader: SSEReader;
}

function run(): Run {
  const events: SSEEvent[] = [];
  const errors: Error[] = [];
  const reader = sseConnect(
    "http://localhost/api/chat",
    { messages: [] },
    (event) => events.push(event),
    (error) => errors.push(error),
    { terminalEvents: CHAT_TERMINAL_EVENTS },
  );
  return { events, errors, reader };
}

/** Let the reader's async loop drain. The stub stream resolves immediately, so
 *  a couple of macrotasks is plenty and keeps the suite deterministic. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const TOKEN = 'event: token\ndata: {"content":"hi"}\n\n';
const DONE = "event: done\ndata: {}\n\n";
const ERROR = 'event: error\ndata: {"message":"boom"}\n\n';

async function main(): Promise<void> {
  section("SSE stream teardown");

  await testAsync("a stream ending with `done` is a clean close", async () => {
    stubFetch({ chunks: [TOKEN, DONE] });
    const r = run();
    await settle();
    assertEqual(r.events.length, 2, "events delivered");
    assertEqual(r.events[1]?.event, "done", "last event");
    assertEqual(r.errors.length, 0, "errors reported");
  });

  await testAsync("a stream ending with `error` is a clean close", async () => {
    stubFetch({ chunks: [TOKEN, ERROR] });
    const r = run();
    await settle();
    assertEqual(r.events[1]?.event, "error", "backend error delivered as an event");
    assertEqual(r.errors.length, 0, "the event is terminal, so the reader must not report again");
  });

  await testAsync("a connection dropped mid-reply is reported", async () => {
    // No done/error — exactly what a sidecar restart or a lost phone link
    // looks like from the client side.
    stubFetch({ chunks: [TOKEN] });
    const r = run();
    await settle();
    assertEqual(r.events.length, 1, "events delivered before the drop");
    assertEqual(r.errors.length, 1, "the drop must be reported once, or the composer stays disabled");
    assertEqual(r.errors[0]?.name, SSE_CLOSED_EARLY, "error marker");
  });

  await testAsync("a stream that dies before its first event is reported", async () => {
    stubFetch({ chunks: [] });
    const r = run();
    await settle();
    assertEqual(r.errors.length, 1, "errors reported");
    assertEqual(r.errors[0]?.name, SSE_CLOSED_EARLY, "error marker");
  });

  await testAsync("an HTTP failure is reported exactly once", async () => {
    stubFetch({ chunks: [], status: 500, errorBody: "internal error" });
    const r = run();
    await settle();
    assertEqual(r.errors.length, 1, "errors reported");
    assert(r.errors[0]?.message.includes("internal error") === true, "error carries the response body");
    assert(r.errors[0]?.name !== SSE_CLOSED_EARLY, "an HTTP failure is not a dropped stream");
  });

  await testAsync("aborting (Stop button) is not reported as a drop", async () => {
    stubFetch({ chunks: [TOKEN], keepOpen: true });
    const r = run();
    await settle();
    r.reader.close();
    await settle();
    assertEqual(r.errors.length, 0, "the user asked for this — no error banner");
  });

  report("sse_stream");
}

void main();
