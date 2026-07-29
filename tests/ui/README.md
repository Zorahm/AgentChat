# UI tests

Node-run TypeScript suites for the parts of the frontend that are pure logic —
the chat tree and the SSE reader. They import `ui/src/...` directly, so they
test the shipped code, not a copy.

```bash
node tests/ui/run.mjs
```

Needs `ui/node_modules` (`npm install --prefix ui`) — the runner compiles with
the repo's own `tsc` and runs the output with Node. There is no test framework:
`src/assert.ts` is the whole thing (~90 lines), and a failing suite sets a
non-zero exit code. Compiled output lands in `tests/ui/.build/` (git-ignored)
and is rebuilt from scratch on every run.

## Suites

| Suite | What it pins down |
|-------|-------------------|
| `src/branch_tree.ts` | Branching (retry → assistant variants, edit → user variants) must not inflate the request sent to the model, must not turn the tree into a graph, and must stay linear in cost. |
| `src/sse_stream.ts` | Which stream endings report through `onError` and which stay silent. |

### Why these two

**`branch_tree`** — Gemini shipped conversation branches and chats started
dying around the tenth message: the client sent the whole branched tree, so the
request grew with every regenerate until the model refused it and the composer
went dead. AgentChat builds each request from `currentBranch()` (it follows
`activeVariantIdx` and never walks `variants[]`), so variants cost nothing on
the wire — the suite asserts the request for "20 turns, retry ×2 on each" is
*byte-identical* to "20 turns, no branches". It also runs the same
duplicate-node walk `useChats/api.ts` runs before persisting: a node reachable
by two paths is what makes a tree serialise exponentially.

**`sse_stream`** — a chat's composer is disabled while its stream is live, and
`useChats` only clears that flag when the stream tears down. A connection that
just *ends* — sidecar restart, backend crash, phone dropping Tailscale — used to
end the reader loop silently, leaving the chat "streaming" and unwritable until
the app was reloaded. `sseConnect` now takes `terminalEvents` and reports a
`SSE_CLOSED_EARLY` error when the body ends without one of them.

## Notes

- `stubs/persistence.js` replaces the compiled `persistence.js` after the build.
  `tree.ts` needs one function from it (`newId`), but the real module also pulls
  in the i18n runtime, which only resolves inside `ui/`.
- `src/node.d.ts` declares the handful of Node globals the suites use; the UI
  has no `@types/node` and doesn't need one.
- Node ≥ 18 (uses global `fetch`, `Response`, `ReadableStream`).
