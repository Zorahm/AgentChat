/** Pure helpers for reading and editing the chat tree (branches, variants). */

import type {
  ChatMessage,
  ChatNode,
  ChatSession,
  UserNode,
  UserVariant,
  AssistantNode,
  AssistantVariant,
} from "../../types/chat";
import type { ToolCall } from "../../types/tool-call";
import { newId } from "./persistence";

/** Walk the active branch and return flat ChatMessage[] for UI. */
export function currentBranch(session: ChatSession): ChatMessage[] {
  const out: ChatMessage[] = [];
  const seen = new Set<ChatNode>();
  let next: ChatNode | undefined = session.root[0];

  while (next) {
    if (seen.has(next)) break; // corrupt cyclic tree — stop instead of hanging
    seen.add(next);
    if (next.role === "user") {
      const uv = next.variants[next.activeVariantIdx];
      if (!uv) break;
      out.push({
        id: next.id,
        role: "user",
        content: uv.content,
        timestamp: uv.createdAt,
        attachments: uv.attachments,
        displayHtml: uv.displayHtml,
        plainText: uv.plainText,
      });
      next = uv.child;
    } else {
      const av = next.variants[next.activeVariantIdx];
      if (!av) break;
      out.push({
        id: next.id,
        role: "assistant",
        content: av.content,
        timestamp: av.createdAt,
        steps: av.steps,
        toolCalls: av.toolCalls,
        reasoningContent: av.reasoningContent,
        webSearchMode: av.webSearchMode,
        usage: av.usage,
      });
      next = av.children[0];
    }
  }
  return out;
}

/** A single message in the wire format sent to POST /api/chat. */
export interface WireMessage {
  role: string;
  content: string;
  tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  tool_call_id?: string;
}

/** Per tool-result cap when replaying prior turns — keeps the model's memory
 *  of what it did without letting a single dump (e.g. a PDF text extract) blow
 *  the context window. Mirrors the backend's intent; see build_agent_messages. */
const TOOL_OUTPUT_REPLAY_LIMIT = 6000;

/** Arguments to replay for a tool call, trimmed where the full input would only
 *  bloat the model's context. show_widget's `html` can be megabytes and the
 *  widget is already rendered for the user — the tool is designed never to echo
 *  its HTML back (see backend/tools/show_widget.py), so we drop it from history
 *  and leave a short note in its place. Every other tool replays verbatim. */
function leanToolArgs(c: ToolCall): Record<string, unknown> {
  const input = c.input ?? {};
  if (c.name === "show_widget" && typeof input.html === "string") {
    return {
      ...input,
      html: "[widget HTML omitted from history — already rendered for the user]",
    };
  }
  return input;
}

/** Expand rendered branch messages into wire messages, replaying each assistant
 *  turn's tool calls + (truncated) results. Without this the backend only sees
 *  assistant *text*, so every fact the model learned through a tool is lost on
 *  the next turn and it re-does the work. */
export function expandToWire(msgs: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of msgs) {
    if (m.role !== "assistant") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const calls = (m.toolCalls ?? []).filter((c) => c.id);
    if (calls.length === 0) {
      out.push({ role: "assistant", content: m.content });
      continue;
    }
    out.push({
      role: "assistant",
      content: m.content,
      tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: leanToolArgs(c) })),
    });
    for (const c of calls) {
      const raw = c.output ?? "";
      const body =
        raw.length > TOOL_OUTPUT_REPLAY_LIMIT
          ? raw.slice(0, TOOL_OUTPUT_REPLAY_LIMIT) + "\n[...truncated]"
          : raw;
      out.push({ role: "tool", tool_call_id: c.id, content: body });
    }
  }
  return out;
}

/** Walk the active branch and return raw ChatNode[] for variant-aware rendering. */
export function currentBranchNodes(session: ChatSession): ChatNode[] {
  const out: ChatNode[] = [];
  const seen = new Set<ChatNode>();
  let next: ChatNode | undefined = session.root[0];

  while (next) {
    if (seen.has(next)) break; // corrupt cyclic tree — stop instead of hanging
    seen.add(next);
    out.push(next);
    if (next.role === "user") {
      const uv = next.variants[next.activeVariantIdx];
      next = uv?.child;
    } else {
      const av = next.variants[next.activeVariantIdx];
      next = av?.children[0];
    }
  }
  return out;
}

interface BranchTail {
  userNode: UserNode | null;
  assistantNode: AssistantNode | null;
  activeVariant: AssistantVariant | null;
}

/** Walk current branch and return the tail nodes (last user + assistant). */
export function findBranchTail(session: ChatSession): BranchTail {
  let userNode: UserNode | null = null;
  let assistantNode: AssistantNode | null = null;
  let activeVariant: AssistantVariant | null = null;

  const seen = new Set<ChatNode>();
  let next: ChatNode | undefined = session.root[0];
  while (next) {
    if (seen.has(next)) break; // corrupt cyclic tree — stop instead of hanging
    seen.add(next);
    if (next.role === "user") {
      userNode = next;
      assistantNode = null;
      activeVariant = null;
      const uv = next.variants[next.activeVariantIdx];
      next = uv?.child;
    } else {
      assistantNode = next;
      activeVariant = next.variants[next.activeVariantIdx] ?? null;
      next = activeVariant?.children[0];
    }
  }
  return { userNode, assistantNode, activeVariant };
}

/** Return the last assistant node in the active branch (or null). */
export function findLastAssistantInBranch(session: ChatSession): {
  nodeId: string;
  variantId: string;
} | null {
  let last: { nodeId: string; variantId: string } | null = null;
  const seen = new Set<ChatNode>();
  let next: ChatNode | undefined = session.root[0];
  while (next) {
    if (seen.has(next)) return last; // corrupt cyclic tree — stop instead of hanging
    seen.add(next);
    if (next.role === "assistant") {
      const v = next.variants[next.activeVariantIdx];
      if (!v) return last;
      last = { nodeId: next.id, variantId: v.id };
      next = v.children[0];
    } else {
      const uv = next.variants[next.activeVariantIdx];
      next = uv?.child;
    }
  }
  return last;
}

/** Check if a specific assistant node is the last assistant in the branch. */
export function isLastAssistantInBranch(session: ChatSession, nodeId: string): boolean {
  const last = findLastAssistantInBranch(session);
  return last?.nodeId === nodeId;
}

/** Deep-update a specific variant within a session tree. */
export function mapVariant(
  session: ChatSession,
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): ChatSession {
  return {
    ...session,
    root: mapNodes(session.root, nodeId, variantId, fn),
  };
}

function mapNodes(
  nodes: ChatNode[],
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): ChatNode[] {
  return nodes.map((node) => {
    if (node.role === "user") return mapUserNode(node, nodeId, variantId, fn);
    return mapAssistantNode(node, nodeId, variantId, fn);
  });
}

function mapUserNode(
  node: UserNode,
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): UserNode {
  return {
    ...node,
    variants: node.variants.map((uv) => ({
      ...uv,
      child: uv.child ? mapAssistantNode(uv.child, nodeId, variantId, fn) : undefined,
    })),
  };
}

function mapAssistantNode(
  node: AssistantNode,
  nodeId: string,
  variantId: string,
  fn: (v: AssistantVariant) => AssistantVariant,
): AssistantNode {
  if (node.id === nodeId) {
    return {
      ...node,
      variants: node.variants.map((v) => (v.id === variantId ? fn(v) : v)),
    };
  }
  return {
    ...node,
    variants: node.variants.map((v) => ({
      ...v,
      children: mapNodes(v.children, nodeId, variantId, fn),
    })),
  };
}

/** Set active variant index on any node (user or assistant) by id. */
export function setActiveVariant(session: ChatSession, nodeId: string, idx: number): ChatSession {
  return mapSessionNodes(session, (node) =>
    node.id === nodeId ? { ...node, activeVariantIdx: idx } : node,
  );
}

function mapSessionNodes(
  session: ChatSession,
  fn: (node: ChatNode) => ChatNode,
): ChatSession {
  return { ...session, root: mapNodesShallow(session.root, fn) };
}

function mapNodesShallow(nodes: ChatNode[], fn: (node: ChatNode) => ChatNode): ChatNode[] {
  return nodes.map((node) => {
    const mapped = fn(node);
    if (mapped !== node) return mapped;
    if (node.role === "user") return mapUserShallow(node, fn);
    return mapAssistantShallow(node, fn);
  });
}

function mapUserShallow(node: UserNode, fn: (n: ChatNode) => ChatNode): UserNode {
  const variants = node.variants.map((uv) => {
    if (!uv.child) return uv;
    const mappedChild = fn(uv.child);
    if (mappedChild !== uv.child) return { ...uv, child: mappedChild as AssistantNode };
    return { ...uv, child: mapAssistantShallow(uv.child, fn) };
  });
  return { ...node, variants };
}

function mapAssistantShallow(node: AssistantNode, fn: (n: ChatNode) => ChatNode): AssistantNode {
  const variants = node.variants.map((v) => ({
    ...v,
    children: mapNodesShallow(v.children, fn),
  }));
  return { ...node, variants };
}

/** Append a user → assistant pair at the end of the active branch.
 *
 * "Active branch" is defined recursively: at every variant-bearing node along
 * the chain, follow `activeVariantIdx`. The new pair is attached as the
 * deepest tail's continuation slot. */
export function appendPair(
  session: ChatSession,
  userNode: UserNode,
  assistantNode: AssistantNode,
): ChatSession {
  // Wire the pair on its own first — variant.child = assistant.
  const uv = userNode.variants[userNode.activeVariantIdx];
  if (uv) uv.child = assistantNode;

  if (session.root.length === 0) {
    return { ...session, root: [userNode] };
  }
  return { ...session, root: attachAfterTail(session.root, userNode) };
}

/** Walk to the deepest tail of the active branch and attach `next` there.
 * The tail is either: the active user variant whose child is empty (attach as
 * its first assistant — but that's not the user→assistant flow; here we're
 * always appending a user node), or the active assistant variant whose
 * children[] is empty (attach `next` as children[0]). */
function attachAfterTail(nodes: ChatNode[], nextUser: UserNode): ChatNode[] {
  if (nodes.length === 0) return [nextUser];
  return nodes.map((node, idx) => {
    if (idx !== 0) return node; // chain is always single-headed
    if (node.role === "user") {
      const uv = node.variants[node.activeVariantIdx];
      if (!uv) return node;
      if (!uv.child) {
        // active user has no assistant yet — illegal state for appending a
        // new user; ignore (caller should not reach here).
        return node;
      }
      const newChild = attachAfterTailAssistant(uv.child, nextUser);
      return {
        ...node,
        variants: node.variants.map((v, i) =>
          i === node.activeVariantIdx ? { ...v, child: newChild } : v,
        ),
      };
    }
    return attachAfterTailAssistant(node, nextUser);
  });
}

function attachAfterTailAssistant(node: AssistantNode, nextUser: UserNode): AssistantNode {
  const av = node.variants[node.activeVariantIdx];
  if (!av) return node;
  if (av.children.length === 0) {
    return {
      ...node,
      variants: node.variants.map((v, i) =>
        i === node.activeVariantIdx ? { ...v, children: [nextUser] } : v,
      ),
    };
  }
  return {
    ...node,
    variants: node.variants.map((v, i) =>
      i === node.activeVariantIdx ? { ...v, children: attachAfterTail(v.children, nextUser) } : v,
    ),
  };
}

/** Add a new empty variant to an assistant node. */
export function addVariant(session: ChatSession, nodeId: string): { session: ChatSession; variantId: string } {
  const variantId = newId();
  const variant: AssistantVariant = {
    id: variantId,
    content: "",
    createdAt: Date.now(),
    children: [],
  };
  return {
    session: mapSessionNodes(session, (node) => {
      if (node.role === "assistant" && node.id === nodeId) {
        return {
          ...node,
          variants: [...node.variants, variant],
          activeVariantIdx: node.variants.length,
        };
      }
      return node;
    }),
    variantId,
  };
}

/** Add a new user variant (editMessage flow). Inherits attachments from the
 * previously active variant. The returned `userVariantId` lets the caller
 * attach a fresh assistant subtree to it. */
export function addUserVariant(
  session: ChatSession,
  userNodeId: string,
  content: string,
  displayHtml: string | undefined,
): { session: ChatSession; userVariantId: string } | null {
  const userVariantId = newId();
  let attached = false;

  const updated = mapSessionNodes(session, (node) => {
    if (node.role !== "user" || node.id !== userNodeId) return node;
    const prev = node.variants[node.activeVariantIdx];
    const variant: UserVariant = {
      id: userVariantId,
      content,
      displayHtml,
      plainText: displayHtml ? undefined : true,
      attachments: prev?.attachments,
      createdAt: Date.now(),
      child: undefined,
    };
    attached = true;
    return {
      ...node,
      variants: [...node.variants, variant],
      activeVariantIdx: node.variants.length,
    };
  });

  if (!attached) return null;
  return { session: updated, userVariantId };
}

/** Set `child` of a specific user variant. Used by editMessage to attach a
 * freshly-minted assistant subtree to the just-created variant. */
export function setUserVariantChild(
  session: ChatSession,
  userNodeId: string,
  userVariantId: string,
  child: AssistantNode,
): ChatSession {
  return mapSessionNodes(session, (node) => {
    if (node.role !== "user" || node.id !== userNodeId) return node;
    return {
      ...node,
      variants: node.variants.map((uv) =>
        uv.id === userVariantId ? { ...uv, child } : uv,
      ),
    };
  });
}
