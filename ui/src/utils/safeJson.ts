/** Cycle- and blowup-tolerant JSON serialization.
 *
 * `JSON.stringify` has two failure modes on a corrupt object graph, both of
 * which — when hit inside a React render/effect — blank the whole app:
 *   1. a true cycle throws `TypeError: cyclic object value`;
 *   2. a DAG where the same subtree is reachable through many paths expands
 *      exponentially and throws `InternalError: allocation size overflow`.
 *
 * `safeStringify` never throws and is always bounded:
 *   - a true back-edge (a node that is its own ancestor) becomes `"[Circular]"`;
 *   - once `MAX_NODES` object-visits is exceeded the rest is dropped.
 * In both cases `hadCycle` is returned true so callers can warn / skip a
 * corrupt write. Genuinely shared structure that fits under the cap — e.g. a
 * ToolCall referenced from both `steps[].call` and `toolCalls[]` — is serialized
 * normally and is NOT mistaken for a cycle (ancestor-path detection, not a flat
 * "seen" set).
 */

export interface SafeStringifyResult {
  json: string;
  hadCycle: boolean;
}

/** Generous ceiling: real chat trees are well under this; a runaway structure
 * blows past it almost immediately, so we cut it off before the engine aborts. */
const MAX_NODES = 200_000;

export function safeStringify(value: unknown): SafeStringifyResult {
  let hadCycle = false;
  let visits = 0;
  const stack: object[] = [];
  const inStack = new Set<object>();

  const json = JSON.stringify(value, function (this: unknown, _key: string, val: unknown) {
    if (val === null || typeof val !== "object") return val;
    if (++visits > MAX_NODES) {
      hadCycle = true;
      return undefined; // pathological size — drop the rest, stay bounded
    }
    const obj = val as object;
    // `this` is the holder of `val`. Unwind the ancestor path back to it so
    // siblings (and shared-but-acyclic refs) are not counted as ancestors.
    while (stack.length > 0 && stack[stack.length - 1] !== this) {
      inStack.delete(stack.pop() as object);
    }
    if (inStack.has(obj)) {
      hadCycle = true;
      return "[Circular]";
    }
    stack.push(obj);
    inStack.add(obj);
    return val;
  });

  return { json: json ?? "null", hadCycle };
}
