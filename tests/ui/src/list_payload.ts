/** List payloads coming back from the backend.
 *
 * Every "fetch a list" hook used to end in `(await r.json()) as Thing[]` — a
 * cast, not a check. So any 200 whose body was not a JSON array (an error
 * envelope like `{"detail": …}`, a proxy's own reply, another service squatting
 * on port 8787) was stored as the list, and the first `.find`/`.map` on it took
 * the whole view down through the ErrorBoundary:
 *
 *     TypeError: agents?.find is not a function   (ModelSelector)
 *
 * `asArray` is the one place that turns an untrusted body into a list, so these
 * cases are what keep the crash from coming back. The contract is deliberately
 * narrow: shape in, list out — it does not validate the elements. */

import { asArray } from "../../../ui/src/utils/asArray";
import { assert, assertEqual, report, section, test } from "./assert";

section("list payload coercion");

test("a real list is passed straight through", () => {
  const agents = [{ id: "default" }, { id: "coder" }];
  assertEqual(asArray(agents), agents, "an array must not be copied or rebuilt");
});

test("an empty list stays an empty list", () => {
  assertEqual(asArray([]).length, 0, "length");
});

test("an error envelope becomes an empty list, not the envelope", () => {
  // The exact payload FastAPI returns for 4xx/5xx, and what a JSON-speaking
  // reverse proxy in front of the backend tends to answer with too.
  assertEqual(asArray({ detail: "Not Found" }).length, 0, "length");
});

test("null and undefined become an empty list", () => {
  // `JSON.parse("null")` is null — a body of literal `null` reaches us as a
  // value, not as a throw, so the catch around the fetch never sees it.
  assertEqual(asArray(null).length, 0, "null");
  assertEqual(asArray(undefined).length, 0, "undefined");
});

test("scalar bodies become an empty list", () => {
  // A string has .length and .map-ish cousins but no .find; a number has
  // nothing. Both must be rejected rather than half-work.
  assertEqual(asArray("nope").length, 0, "string");
  assertEqual(asArray(42).length, 0, "number");
  assertEqual(asArray(true).length, 0, "boolean");
});

test("the result always answers .find — the call site that crashed", () => {
  const payloads: unknown[] = [
    [{ id: "default" }],
    { detail: "Not Found" },
    null,
    undefined,
    "nope",
    42,
  ];
  for (const payload of payloads) {
    const list = asArray<{ id: string }>(payload);
    assert(
      typeof list.find === "function",
      `no .find after coercing ${JSON.stringify(payload) ?? "undefined"}`,
    );
    // ModelSelector does exactly this, then falls back to the default agent.
    assert(
      list.find((a) => a.id === "missing") === undefined,
      "a miss must be undefined, not a throw",
    );
  }
});

report("list_payload");
