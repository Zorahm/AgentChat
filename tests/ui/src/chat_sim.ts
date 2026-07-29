/** Drives the real chat-tree helpers (`ui/src/hooks/useChats/tree.ts`) the same
 *  way `useChats/index.ts` drives them, so a suite can grow a session exactly
 *  as a user would and measure what it costs. Nothing here is a re-implementation
 *  — every mutation goes through the shipped helper. */

import type {
  AssistantNode,
  AssistantVariant,
  ChatNode,
  ChatSession,
  UserNode,
  UserVariant,
} from "../../../ui/src/types/chat";
import type { ToolCall } from "../../../ui/src/types/tool-call";
import {
  addUserVariant,
  addVariant,
  appendPair,
  currentBranch,
  expandToWire,
  findLastAssistantInBranch,
  mapVariant,
  setActiveVariant,
  setUserVariantChild,
} from "../../../ui/src/hooks/useChats/tree";

/** Realistic per-turn payload: a couple of KB of prose plus one fat tool
 *  result, which is what actually dominates a stored chat. */
const ASSISTANT_TEXT = "x".repeat(2000);
const TOOL_OUTPUT = "y".repeat(20000);

// Fixed-width ids: node/tool-call ids are serialised into the wire payload, so
// a wider counter in one scenario than another would shift the byte counts the
// suite compares.
let counter = 0;
const nextId = (): string => `n${String(++counter).padStart(6, "0")}`;

export function emptySession(): ChatSession {
  return { id: "sim", title: "New chat", root: [], createdAt: 0 };
}

function toolCall(): ToolCall {
  return {
    id: nextId(),
    name: "read_file",
    input: { path: "~/AgentChat/chats/chat-sim/notes.md" },
    output: TOOL_OUTPUT,
    status: "success",
  };
}

function newAssistant(): { node: AssistantNode; variantId: string } {
  const variant: AssistantVariant = {
    id: nextId(),
    content: "",
    createdAt: 0,
    toolCalls: [],
    children: [],
  };
  return {
    node: { id: nextId(), role: "assistant", variants: [variant], activeVariantIdx: 0 },
    variantId: variant.id,
  };
}

/** Stand-in for the SSE stream filling a variant with text + one tool call. */
function stream(session: ChatSession, nodeId: string, variantId: string): ChatSession {
  return mapVariant(session, nodeId, variantId, (v) => ({
    ...v,
    content: ASSISTANT_TEXT,
    toolCalls: [toolCall()],
  }));
}

/** useChats.sendMessage() — append a user→assistant pair to the active branch. */
export function send(session: ChatSession, text: string): ChatSession {
  const userVariant: UserVariant = { id: nextId(), content: text, plainText: true, createdAt: 0 };
  const user: UserNode = { id: nextId(), role: "user", variants: [userVariant], activeVariantIdx: 0 };
  const assistant = newAssistant();
  return stream(appendPair(session, user, assistant.node), assistant.node.id, assistant.variantId);
}

/** useChats.retry() — regenerate the last answer as a new assistant variant. */
export function retry(session: ChatSession): ChatSession {
  const last = findLastAssistantInBranch(session);
  if (!last) throw new Error("retry() called on a session with no assistant turn");
  const { session: withVariant, variantId } = addVariant(session, last.nodeId);
  return stream(withVariant, last.nodeId, variantId);
}

/** useChats.editMessage() — new user variant carrying its own assistant subtree. */
export function edit(session: ChatSession, userNodeId: string, text: string): ChatSession {
  const added = addUserVariant(session, userNodeId, text, undefined);
  if (!added) throw new Error(`edit() found no user node ${userNodeId}`);
  const assistant = newAssistant();
  const wired = setUserVariantChild(added.session, userNodeId, added.userVariantId, assistant.node);
  return stream(wired, assistant.node.id, assistant.variantId);
}

/** useChats.switchVariant() — flip which branch is active at `nodeId`. */
export function switchTo(session: ChatSession, nodeId: string, idx: number): ChatSession {
  return setActiveVariant(session, nodeId, idx);
}

/** Id of the last assistant node on the active branch (the retry target). */
export function lastAssistantId(session: ChatSession): string {
  const last = findLastAssistantInBranch(session);
  if (!last) throw new Error("no assistant turn in this session");
  return last.nodeId;
}

// ── measurement ────────────────────────────────────────────────────────────

/** The same walk `useChats/api.ts` runs before persisting: it reports a node
 *  reachable by two paths, which is what makes a tree serialise exponentially
 *  (Gemini's branch bug) instead of linearly. */
export function corruption(root: readonly ChatNode[]): { nodes: number; anomaly: string | null } {
  const seen = new Set<ChatNode>();
  let visits = 0;
  const stack: Array<{ node: ChatNode; path: string }> = root.map((n, i) => ({
    node: n,
    path: `root[${i}]`,
  }));
  while (stack.length > 0) {
    if (++visits > 200_000) return { nodes: visits, anomaly: "runaway structure (>200k visits)" };
    const top = stack.pop();
    if (!top) break;
    const { node, path } = top;
    if (seen.has(node)) {
      return { nodes: seen.size, anomaly: `node ${node.id} re-referenced at ${path}` };
    }
    seen.add(node);
    if (node.role === "user") {
      node.variants.forEach((v, vi) => {
        if (v.child) stack.push({ node: v.child, path: `${path}.v[${vi}].child` });
      });
    } else {
      node.variants.forEach((v, vi) => {
        v.children.forEach((c, ci) =>
          stack.push({ node: c, path: `${path}.v[${vi}].children[${ci}]` }),
        );
      });
    }
  }
  return { nodes: seen.size, anomaly: null };
}

export interface Metrics {
  readonly label: string;
  /** Messages rendered on the active branch. */
  readonly branch: number;
  /** Wire messages POSTed to /api/chat (user + assistant + tool results). */
  readonly wire: number;
  /** Bytes of that request body — the number Gemini's bug blew up. */
  readonly wireBytes: number;
  /** Bytes of the full tree PUT to /api/chats (every variant, every branch). */
  readonly storedBytes: number;
  readonly nodes: number;
  readonly anomaly: string | null;
  readonly walkMs: number;
}

export function measure(label: string, session: ChatSession): Metrics {
  const started = performance.now();
  const storedBytes = JSON.stringify(session.root).length;
  const branch = currentBranch(session);
  const wire = expandToWire(branch);
  const wireBytes = JSON.stringify(wire).length;
  const walkMs = performance.now() - started;
  const { nodes, anomaly } = corruption(session.root);
  return {
    label,
    branch: branch.length,
    wire: wire.length,
    wireBytes,
    storedBytes,
    nodes,
    anomaly,
    walkMs,
  };
}

const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

export function printTable(title: string, rows: readonly Metrics[]): void {
  console.log(`\n  ${title}`);
  console.log(
    `  ${"step".padEnd(32)}${"msgs".padStart(6)}${"wire".padStart(6)}` +
      `${"wireKB".padStart(9)}${"storedKB".padStart(10)}${"nodes".padStart(7)}${"ms".padStart(7)}  status`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(32)}${String(r.branch).padStart(6)}${String(r.wire).padStart(6)}` +
        `${kb(r.wireBytes).padStart(9)}${kb(r.storedBytes).padStart(10)}` +
        `${String(r.nodes).padStart(7)}${r.walkMs.toFixed(2).padStart(7)}  ${r.anomaly ?? "ok"}`,
    );
  }
}
