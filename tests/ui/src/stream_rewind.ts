/** What the client does when the backend freezes a turn and tries again.
 *
 * The backend retries one model call at a time, keeping the conversation and
 * every finished tool result. The client's half of that bargain is to take the
 * abandoned attempt's output back off the screen — otherwise a connection that
 * dies mid-sentence leaves half an answer in the transcript and the retry
 * writes the full answer underneath it, so the model appears to stutter.
 *
 * Two things are easy to get wrong here, and both are covered below:
 *
 *  - the rewind point is not "the end of the last step". Tokens are appended to
 *    the trailing text step rather than pushed as a new one, so a pass that
 *    starts mid-paragraph must remember how long that paragraph already was;
 *  - a tool call whose arguments were still streaming when the socket dropped
 *    has to go. It will never run, and a row that sits at "running" forever is
 *    a worse lie than no row.
 *
 * The message-ring's wrap-around rules ride along in the same suite: they are
 * the other piece of pure logic behind this change.
 */

import { markPass, rewindPass } from "../../../ui/src/hooks/useChats/tree";
import { nextFocusIndex } from "../../../ui/src/utils/messageRing";
import type { AssistantVariant } from "../../../ui/src/types/chat";
import type { ProcessStep, ToolCall } from "../../../ui/src/types/tool-call";
import { assert, assertEqual, report, section, test } from "./assert";

function variant(over: Partial<AssistantVariant> = {}): AssistantVariant {
  return {
    id: "v1",
    content: "",
    steps: [],
    toolCalls: [],
    createdAt: 0,
    children: [],
    ...over,
  };
}

function call(id: string, status: ToolCall["status"] = "success"): ToolCall {
  return { id, name: "read_file", input: {}, status };
}

section("Rewinding an abandoned attempt");

test("text streamed by the failed attempt is taken back out", () => {
  const before = variant({
    content: "Earlier answer. ",
    steps: [{ type: "text", content: "Earlier answer. " }],
  });
  const mark = markPass(before);

  const during: AssistantVariant = {
    ...before,
    content: "Earlier answer. Half a sen",
    steps: [{ type: "text", content: "Earlier answer. Half a sen" }],
  };

  const after = rewindPass(during, mark);
  assertEqual(after.content, "Earlier answer. ", "content");
  assertEqual((after.steps ?? []).length, 1, "step count");
  const step = after.steps?.[0] as Extract<ProcessStep, { type: "text" }>;
  assertEqual(step.content, "Earlier answer. ", "trailing step text");
});

test("a pass that started a brand-new step drops the whole step", () => {
  const before = variant({ steps: [{ type: "tool", call: call("c1") }] });
  const mark = markPass(before);

  const during: AssistantVariant = {
    ...before,
    content: "New paragraph",
    steps: [{ type: "tool", call: call("c1") }, { type: "text", content: "New paragraph" }],
  };

  const after = rewindPass(during, mark);
  assertEqual((after.steps ?? []).length, 1, "step count");
  assertEqual(after.content, "", "content");
});

test("half-streamed tool calls are dropped, finished ones are kept", () => {
  const before = variant({
    toolCalls: [call("done-1")],
    steps: [{ type: "tool", call: call("done-1") }],
  });
  const mark = markPass(before);

  const during: AssistantVariant = {
    ...before,
    toolCalls: [call("done-1"), call("half-2", "running")],
    steps: [
      { type: "tool", call: call("done-1") },
      { type: "tool", call: call("half-2", "running") },
    ],
  };

  const after = rewindPass(during, mark);
  assertEqual((after.toolCalls ?? []).map((c) => c.id).join(","), "done-1", "kept calls");
  assertEqual((after.steps ?? []).length, 1, "kept steps");
});

test("reasoning is rewound alongside the answer", () => {
  const before = variant({
    reasoningContent: "kept. ",
    steps: [{ type: "thought", content: "kept. " }],
  });
  const mark = markPass(before);

  const during: AssistantVariant = {
    ...before,
    reasoningContent: "kept. abandoned",
    steps: [{ type: "thought", content: "kept. abandoned" }],
  };

  const after = rewindPass(during, mark);
  assertEqual(after.reasoningContent, "kept. ", "reasoning");
  const step = after.steps?.[0] as Extract<ProcessStep, { type: "thought" }>;
  assertEqual(step.content, "kept. ", "thought step");
});

test("rewinding an attempt that said nothing changes nothing", () => {
  const before = variant({
    content: "all of it",
    steps: [{ type: "text", content: "all of it" }],
    toolCalls: [call("c1")],
  });
  const mark = markPass(before);

  const after = rewindPass(before, mark);
  assertEqual(after.content, "all of it", "content");
  assertEqual((after.steps ?? []).length, 1, "steps");
  assertEqual((after.toolCalls ?? []).length, 1, "tool calls");
});

test("two failures in a row rewind to the same point, not further", () => {
  const before = variant({
    content: "kept",
    steps: [{ type: "text", content: "kept" }],
  });
  const mark = markPass(before);

  const first = rewindPass(
    { ...before, content: "kept then junk", steps: [{ type: "text", content: "kept then junk" }] },
    mark,
  );
  const second = rewindPass(
    { ...first, content: "kept more junk", steps: [{ type: "text", content: "kept more junk" }] },
    mark,
  );

  assertEqual(second.content, "kept", "content after the second rewind");
});

section("The message ring's wrap-around");

test("entering from nowhere lands on the newest message", () => {
  assertEqual(nextFocusIndex(null, -1, 5), 4, "Alt+↑ from the composer");
  assertEqual(nextFocusIndex(null, 1, 5), 4, "Alt+↓ from the composer");
});

test("walking off the bottom hands the keyboard back", () => {
  assert(nextFocusIndex(4, 1, 5) === null, "past the last message clears the ring");
});

test("walking off the top stops at the first message", () => {
  assertEqual(nextFocusIndex(0, -1, 5), 0, "already at the oldest");
});

test("an empty conversation has nowhere to go", () => {
  assert(nextFocusIndex(null, -1, 0) === null, "no messages");
});

report("stream_rewind");
