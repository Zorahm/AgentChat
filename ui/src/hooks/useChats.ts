/** Multi-session chat manager with tree-based variant model. */

import { useCallback, useEffect, useRef, useState } from "react";
import { sseConnect } from "./useSSE";
import type { SSEEvent, SSEReader } from "./useSSE";
import type {
  ChatMessage,
  ChatNode,
  UserNode,
  UserVariant,
  AssistantNode,
  AssistantVariant,
  AttachmentInfo,
} from "../types/chat";
import type { ChatSession } from "../types/chat";
import type { ToolCall, ProcessStep } from "../types/tool-call";
import type { LiveFile } from "../types/artifact";
import { API_BASE } from "../utils/apiBase";
import { safeStringify } from "../utils/safeJson";
import { i18n } from "../i18n";

// ── Public types ───────────────────────────────────────────────────────────

export type { ChatSession } from "../types/chat";

export interface AgentChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  liveFiles: LiveFile[];
  error: string | null;
}

export interface UseChatResult {
  sessions: ChatSession[];
  activeId: string;
  activeDirSlug: string | null;
  activeMcpEnabled: string[];
  messages: ChatMessage[];
  branchNodes: ChatNode[];
  liveFiles: LiveFile[];
  isStreaming: boolean;
  error: string | null;
  newChat: (projectId?: string) => void;
  startProjectChat: (
    projectId: string,
    text: string,
    model?: string,
    attachments?: AttachmentInfo[],
    html?: string,
    dirSlug?: string,
  ) => void;
  switchChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  pinChat: (id: string) => void;
  sendMessage: (text: string, model?: string, attachments?: AttachmentInfo[], html?: string, thinkingEnabled?: boolean, effort?: string) => void;
  retry: () => void;
  editMessage: (userNodeId: string, content: string, displayHtml?: string) => void;
  switchVariant: (nodeId: string, idx: number) => void;
  abort: () => void;
  startGhostChat: () => void;
  toggleMcpServer: (serverId: string) => void;
}

// ── Persistence & migration ────────────────────────────────────────────────

const PINNED_KEY = "aic-pinned-v1";

function loadPinnedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function savePinnedIds(ids: Set<string>): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...ids]));
}

const STORAGE_KEY = "aic-sessions-v2";
const OLD_STORAGE_KEY = "aic-sessions-v1";
const MIGRATION_FLAG = "aic-migration-v3-done";
const SAVE_DEBOUNCE_MS = 1500;

interface StoredSession {
  id: string;
  title: string;
  messages?: ChatMessage[];
  root?: ChatNode[];
  createdAt: number;
}

function migrateSession(old: StoredSession): ChatSession {
  const flatMsgs = old.messages ?? [];
  let firstUser: UserNode | null = null;
  let attachNextUser: ((n: UserNode) => void) | null = null;

  for (let i = 0; i < flatMsgs.length; i += 2) {
    const userMsg = flatMsgs[i]!;
    const assistantMsg = flatMsgs[i + 1];

    const userVariant: UserVariant = {
      id: `${userMsg.id}-v0`,
      content: userMsg.content,
      attachments: userMsg.attachments,
      createdAt: userMsg.timestamp,
    };
    const userNode: UserNode = {
      id: userMsg.id,
      role: "user",
      variants: [userVariant],
      activeVariantIdx: 0,
    };

    if (!firstUser) firstUser = userNode;
    else if (attachNextUser) attachNextUser(userNode);

    if (assistantMsg) {
      const assistantVariant: AssistantVariant = {
        id: assistantMsg.id,
        content: assistantMsg.content,
        steps: assistantMsg.steps,
        toolCalls: assistantMsg.toolCalls,
        reasoningContent: assistantMsg.reasoningContent,
        createdAt: assistantMsg.timestamp,
        children: [],
      };
      const assistantNode: AssistantNode = {
        id: assistantMsg.id,
        role: "assistant",
        variants: [assistantVariant],
        activeVariantIdx: 0,
      };
      userVariant.child = assistantNode;
      attachNextUser = (n) => { assistantVariant.children = [n]; };
    } else {
      attachNextUser = null;
    }
  }

  const root: ChatNode[] = firstUser ? [firstUser] : [];
  return { id: old.id, title: old.title, root, createdAt: old.createdAt };
}

// ── Tree-shape migration (legacy `[user, assistant, ...]` array → chained) ─

interface LegacyUserNode {
  id: string;
  role: "user";
  content?: string;
  displayHtml?: string;
  attachments?: AttachmentInfo[];
  createdAt?: number;
  child?: unknown;
  variants?: unknown;
  activeVariantIdx?: number;
}

interface LegacyAssistantNode {
  id: string;
  role: "assistant";
  variants?: unknown;
  activeVariantIdx?: number;
}

/** Convert any persisted tree (legacy array-pair OR already-chained) into
 * the canonical chained form: root[0] is the first user, every continuation
 * is reached via userVariant.child or assistantVariant.children[0]. */
function migrateTreeNodes(raw: unknown): ChatNode[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const nodes = raw as Array<LegacyUserNode | LegacyAssistantNode>;
  const first = nodes[0];
  if (!first || first.role !== "user") return [];

  const head = migrateUserNode(first);
  // Wire siblings: legacy stored [u0, a0, u1, a1, ...]. Each consecutive pair
  // chains via userVariant.child = assistant + assistantVariant.children = [nextUser].
  let cursorUserVariant: UserVariant | null = head.variants[head.activeVariantIdx] ?? null;
  let cursorAssistantVariant: AssistantVariant | null = null;

  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.role === "assistant") {
      const a = migrateAssistantNode(n);
      if (cursorUserVariant && !cursorUserVariant.child) cursorUserVariant.child = a;
      cursorAssistantVariant = a.variants[a.activeVariantIdx] ?? null;
      cursorUserVariant = null;
    } else {
      const u = migrateUserNode(n);
      if (cursorAssistantVariant && cursorAssistantVariant.children.length === 0) {
        cursorAssistantVariant.children = [u];
      }
      cursorUserVariant = u.variants[u.activeVariantIdx] ?? null;
      cursorAssistantVariant = null;
    }
  }
  return [head];
}

function migrateUserNode(raw: LegacyUserNode): UserNode {
  // Already in new shape?
  if (Array.isArray(raw.variants) && typeof raw.activeVariantIdx === "number") {
    const rawVariants = raw.variants as Array<Record<string, unknown>>;
    return {
      id: raw.id,
      role: "user",
      variants: rawVariants.map((v) => migrateUserVariant(v)),
      activeVariantIdx: raw.activeVariantIdx,
    };
  }
  // Legacy { content, child? } → wrap in single variant.
  const variant: UserVariant = {
    id: `${raw.id}-v0`,
    content: raw.content ?? "",
    displayHtml: raw.displayHtml,
    attachments: raw.attachments,
    createdAt: raw.createdAt ?? Date.now(),
    child: raw.child ? migrateAssistantNode(raw.child as LegacyAssistantNode) : undefined,
  };
  return {
    id: raw.id,
    role: "user",
    variants: [variant],
    activeVariantIdx: 0,
  };
}

function migrateUserVariant(raw: Record<string, unknown>): UserVariant {
  const child = raw.child as LegacyAssistantNode | undefined;
  return {
    id: String(raw.id ?? ""),
    content: String(raw.content ?? ""),
    displayHtml: raw.displayHtml as string | undefined,
    attachments: raw.attachments as AttachmentInfo[] | undefined,
    createdAt: Number(raw.createdAt ?? Date.now()),
    child: child ? migrateAssistantNode(child) : undefined,
  };
}

function migrateAssistantNode(raw: LegacyAssistantNode): AssistantNode {
  const rawVariants = Array.isArray(raw.variants)
    ? (raw.variants as Array<Record<string, unknown>>)
    : [];
  return {
    id: raw.id,
    role: "assistant",
    variants: rawVariants.map((v) => ({
      id: String(v.id ?? ""),
      content: String(v.content ?? ""),
      steps: v.steps as AssistantVariant["steps"],
      toolCalls: v.toolCalls as AssistantVariant["toolCalls"],
      reasoningContent: v.reasoningContent as string | undefined,
      createdAt: Number(v.createdAt ?? Date.now()),
      children: migrateTreeNodes(v.children),
    })),
    activeVariantIdx: raw.activeVariantIdx ?? 0,
  };
}

/** Read sessions from localStorage. Used only by the one-shot migration to
 * SQLite — after migration the backend is the source of truth. */
function readLocalSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as StoredSession[];
      if (Array.isArray(data) && data.length > 0 && data[0]!.root) {
        return (data as ChatSession[]).map(backfillDirSlug);
      }
    }
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
    if (oldRaw) {
      const oldData = JSON.parse(oldRaw) as StoredSession[];
      if (Array.isArray(oldData)) {
        return oldData.map(migrateSession).map(backfillDirSlug);
      }
    }
  } catch {
    /* corrupt — caller treats as no data */
  }
  return [];
}

/** Older sessions predate per-chat folders. Assign a slug derived from createdAt
 * so the folder is stable across reloads (no UUID drift). */
function backfillDirSlug(s: ChatSession): ChatSession {
  if (s.dirSlug) return s;
  const d = new Date(s.createdAt || Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const short = s.id.replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase() || "old0";
  return { ...s, dirSlug: `chat-${short}-${ts}` };
}

export function makeDirSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const id = Math.random().toString(36).slice(2, 6);
  return `chat-${id}-${ts}`;
}

function makeSession(projectId?: string, dirSlug?: string): ChatSession {
  // Guard against a non-string projectId — e.g. a click handler wired as
  // `onClick={onNew}` forwards the MouseEvent here, and a DOM event is a
  // deeply circular object that poisons every JSON.stringify of the session.
  const pid = typeof projectId === "string" && projectId ? projectId : undefined;
  return {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: i18n.t("chat.newChatTitle"),
    root: [],
    createdAt: Date.now(),
    // A caller may pre-allocate the slug (the project composer uploads its
    // first attachment before the chat exists; the upload must land in this
    // chat's sandbox, so the slug has to be known up front).
    dirSlug: dirSlug || makeDirSlug(),
    projectId: pid,
  };
}

function deriveTitle(msgs: ChatMessage[]): string {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return i18n.t("chat.newChatTitle");
  const t = first.content.replace(/\s+/g, " ").trim();
  return t.length > 50 ? t.slice(0, 48) + "…" : t;
}

let nextMsgId = 1;
const newId = () => String(nextMsgId++);

// ── Backend API helpers ────────────────────────────────────────────────────

interface ChatSummaryDTO {
  id: string;
  title: string;
  dir_slug: string;
  project_id?: string;
  created_at: number;
  updated_at: number;
}

interface ChatFullDTO extends ChatSummaryDTO {
  root: ChatNode[];
  mcp_enabled?: string[];
}

function summaryToSession(s: ChatSummaryDTO): ChatSession {
  return {
    id: s.id,
    title: s.title,
    root: [],
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    dirSlug: s.dir_slug || undefined,
    projectId: s.project_id || undefined,
  };
}

function fullToSession(f: ChatFullDTO): ChatSession {
  return {
    id: f.id,
    title: f.title,
    root: migrateTreeNodes(f.root ?? []),
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    dirSlug: f.dir_slug || undefined,
    mcpEnabledServers: Array.isArray(f.mcp_enabled) ? f.mcp_enabled : [],
    projectId: f.project_id || undefined,
  };
}

async function fetchChatList(): Promise<ChatSession[]> {
  try {
    const r = await fetch(`${API_BASE}/chats`);
    if (!r.ok) return [];
    const list = (await r.json()) as ChatSummaryDTO[];
    return list.map(summaryToSession);
  } catch {
    return [];
  }
}

async function fetchChatFull(id: string): Promise<ChatSession | null> {
  try {
    const r = await fetch(`${API_BASE}/chats/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return fullToSession(await r.json());
  } catch {
    return null;
  }
}

async function createChatRemote(s: ChatSession): Promise<ChatSession> {
  try {
    const { json, hadCycle } = safeStringify({
      id: s.id,
      title: s.title,
      dir_slug: s.dirSlug ?? "",
      root: s.root,
      created_at: s.createdAt,
      mcp_enabled: s.mcpEnabledServers ?? [],
      project_id: s.projectId ?? "",
    });
    // A cyclic payload is corrupt — sending it would fail backend validation
    // (422). Skip the create and keep the local copy rather than POST garbage.
    if (hadCycle) {
      warnCyclicTree("createChatRemote (create skipped)", s);
      return s;
    }
    const r = await fetch(`${API_BASE}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
    });
    if (r.ok) return fullToSession(await r.json());
  } catch {
    /* fall through */
  }
  return s; // offline — keep local copy; debounced save will retry
}

async function putChatRemote(s: ChatSession): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      title: s.title,
      root: s.root,
      mcp_enabled: s.mcpEnabledServers ?? [],
      project_id: s.projectId ?? "",
    };
    // Never overwrite a non-empty dir_slug with an empty string — this
    // would break WSL folder cleanup on deletion.
    if (s.dirSlug) body.dir_slug = s.dirSlug;
    const { json, hadCycle } = safeStringify(body);
    // A cyclic tree is corrupt; don't clobber the last good server copy with
    // a cycle-broken payload. Skip this write and keep the previous version.
    if (hadCycle) {
      warnCyclicTree("putChatRemote (save skipped)", s);
      return;
    }
    await fetch(`${API_BASE}/chats/${encodeURIComponent(s.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json,
    });
  } catch {
    /* will retry on next change */
  }
}

async function deleteChatRemote(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* no-op */
  }
}

/** One-shot migration: drain localStorage chats into the SQLite backend. */
async function maybeMigrateLocalStorage(): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG)) return;
  const local = readLocalSessions();
  if (local.length === 0) {
    localStorage.setItem(MIGRATION_FLAG, "1");
    return;
  }
  for (const s of local) {
    await createChatRemote(s);
  }
  localStorage.setItem(MIGRATION_FLAG, "1");
  // Don't delete STORAGE_KEY — keep as a local fallback in case the user
  // wants to recover. The migration flag prevents re-import on next load.
}

/** Pinpoint where a chat tree first re-references a node — the corruption that
 * makes serialization cycle or blow up exponentially. Uses a flat visited-set
 * (so it catches both true cycles AND duplicate-parent DAGs) and is bounded by
 * a visit cap so the diagnostic itself can never hang. Returns a description
 * with the offending node id + structural path, or null if the tree is sound. */
function describeTreeCorruption(root: ChatNode[]): string | null {
  const seen = new Set<ChatNode>();
  let visits = 0;
  const stack: Array<{ node: ChatNode; path: string }> = root.map((n, i) => ({
    node: n,
    path: `root[${i}]`,
  }));
  while (stack.length > 0) {
    if (++visits > 200_000) return "tree exceeds 200k nodes — runaway/exponential structure";
    const { node, path } = stack.pop()!;
    if (seen.has(node)) {
      return `node ${node.id} (${node.role}) re-referenced at ${path} — duplicate parent or back-edge`;
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
  return null;
}

/** Diagnostic for Bug B (a corrupt — cyclic or exponentially-shared — chat
 * tree). The corruption is created at runtime by some tree edit; logging the
 * offending chat + the exact node/path lets us trace the source on next repro. */
function warnCyclicTree(where: string, s: ChatSession): void {
  console.error(
    `[useChats] corrupt chat tree at ${where} — chat ${s.id} ("${s.title}"). ` +
      `Anomaly: ${describeTreeCorruption(s.root) ?? "(in a non-root field)"}. ` +
      `Persistence of the corrupt payload is skipped. Please report the steps that led here.`,
  );
}

/** Stable JSON snapshot for change detection. Skips ChatSession identity
 * fields the backend doesn't care about. Cycle-tolerant: never throws (a throw
 * here, run inside a render effect, would blank the whole app). */
function snapshot(s: ChatSession): string {
  const { json, hadCycle } = safeStringify({
    t: s.title,
    d: s.dirSlug ?? "",
    r: s.root,
    m: s.mcpEnabledServers ?? [],
    p: s.projectId ?? "",
  });
  if (hadCycle) warnCyclicTree("snapshot", s);
  return json;
}

// ── Tree helpers ───────────────────────────────────────────────────────────

/** Walk the active branch and return flat ChatMessage[] for UI. */
function currentBranch(session: ChatSession): ChatMessage[] {
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
      });
      next = av.children[0];
    }
  }
  return out;
}

/** Walk the active branch and return raw ChatNode[] for variant-aware rendering. */
function currentBranchNodes(session: ChatSession): ChatNode[] {
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
function findBranchTail(session: ChatSession): BranchTail {
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
function findLastAssistantInBranch(session: ChatSession): {
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
function isLastAssistantInBranch(session: ChatSession, nodeId: string): boolean {
  const last = findLastAssistantInBranch(session);
  return last?.nodeId === nodeId;
}

/** Deep-update a specific variant within a session tree. */
function mapVariant(
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
function setActiveVariant(session: ChatSession, nodeId: string, idx: number): ChatSession {
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
function appendPair(
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
function addVariant(session: ChatSession, nodeId: string): { session: ChatSession; variantId: string } {
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
function addUserVariant(
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
function setUserVariantChild(
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

// ── Hook ───────────────────────────────────────────────────────────────────

export function useChats(): UseChatResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [liveFiles, setLiveFiles] = useState<LiveFile[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sseRef = useRef<SSEReader | null>(null);
  const streamingTargetRef = useRef<{ nodeId: string; variantId: string } | null>(null);
  const initializedRef = useRef(false);
  /** Per-session JSON snapshot of the last value pushed to the backend. The
   * effect that debounces saves compares against this to skip no-op writes. */
  const lastSavedRef = useRef<Map<string, string>>(new Map());
  /** Per-session pending save timer. */
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** First message queued by startProjectChat, fired once the new chat is active. */
  const pendingSendRef = useRef<{
    sessionId: string;
    content: string;
    model?: string;
    attachments?: AttachmentInfo[];
    html?: string;
  } | null>(null);

  // ── Initial load + one-shot migration ─────────────────────────────────
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    (async () => {
      await maybeMigrateLocalStorage();
      const pinnedIds = loadPinnedIds();
      const remote = await fetchChatList();
      if (remote.length === 0) {
        const fresh = makeSession();
        const created = await createChatRemote(fresh);
        setSessions([created]);
        setActiveId(created.id);
        lastSavedRef.current.set(created.id, snapshot(created));
        return;
      }
      // Lazy-load: fetch the most recently updated chat's full tree right away
      // so the user sees something on first paint. Other chats are loaded on switch.
      const active = remote[0]!;
      const full = await fetchChatFull(active.id);
      const hydrated = remote.map((s) => ({
        ...(s.id === active.id && full ? full : s),
        pinned: pinnedIds.has(s.id),
      }));
      setSessions(hydrated);
      setActiveId(active.id);
      for (const s of hydrated) {
        lastSavedRef.current.set(s.id, snapshot(s));
      }
    })();
  }, []);

  // ── Debounced auto-save ───────────────────────────────────────────────
  useEffect(() => {
    for (const s of sessions) {
      const snap = snapshot(s);
      if (lastSavedRef.current.get(s.id) === snap) continue;
      const existing = saveTimersRef.current.get(s.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        // Read latest from closure — but we need fresh state, so look it up
        // via the snapshot. We persist whatever the sessions array carries at
        // schedule time; that's stale-by-one-batch at worst, fine for autosave.
        void putChatRemote(s).then(() => {
          lastSavedRef.current.set(s.id, snap);
          saveTimersRef.current.delete(s.id);
        });
      }, SAVE_DEBOUNCE_MS);
      saveTimersRef.current.set(s.id, timer);
    }
  }, [sessions]);

  // Flush pending saves on unload (best-effort; navigator.sendBeacon doesn't
  // help here because PUT body is JSON — but the browser may still complete
  // the fetch if we don't await).
  useEffect(() => {
    const flush = () => {
      for (const [id, timer] of saveTimersRef.current.entries()) {
        clearTimeout(timer);
        const s = sessions.find((x) => x.id === id);
        if (s) void putChatRemote(s);
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const messages = activeSession ? currentBranch(activeSession) : [];
  const branchNodes: ChatNode[] = activeSession ? currentBranchNodes(activeSession) : [];

  // ── SSE handler factory ─────────────────────────────────────────────────

  const updateLiveFile = useCallback(
    (callId: string, updater: (lf: LiveFile) => LiveFile) => {
      setLiveFiles((prev) => prev.map((lf) => (lf.id === callId ? updater(lf) : lf)));
    },
    [],
  );

  const makeEventHandler = useCallback(
    (sessionId: string, nodeId: string, variantId: string) => (event: SSEEvent) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        switch (event.event) {
          case "token": {
            const text = String(data.content ?? "");
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  const last = steps[steps.length - 1];
                  if (last?.type === "text") {
                    steps[steps.length - 1] = { type: "text", content: last.content + text };
                  } else {
                    steps.push({ type: "text", content: text });
                  }
                  return { ...v, content: v.content + text, steps };
                });
              }),
            );
            break;
          }
          case "reasoning": {
            const text = String(data.content ?? "");
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  const last = steps[steps.length - 1];
                  if (last?.type === "text") {
                    steps.push({ type: "break" });
                  }
                  const tail = steps[steps.length - 1];
                  if (tail?.type === "thought") {
                    steps[steps.length - 1] = { type: "thought", content: tail.content + text };
                  } else {
                    steps.push({ type: "thought", content: text });
                  }
                  return { ...v, steps, reasoningContent: (v.reasoningContent ?? "") + text };
                });
              }),
            );
            break;
          }
          case "reasoning_break": {
            // Ignore - breaks are now only inserted when text precedes reasoning/tool_start
            break;
          }
          case "tool_start": {
            const tc: ToolCall = {
              id: String(data.id ?? ""),
              name: String(data.name ?? ""),
              input: (data.input as Record<string, unknown>) ?? {},
              status: "running",
            };
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => {
                  const steps: ProcessStep[] = [...(v.steps ?? [])];
                  const last = steps[steps.length - 1];
                  if (last?.type === "text") {
                    steps.push({ type: "break" });
                  }
                  steps.push({ type: "tool" as const, call: tc });
                  return { ...v, steps, toolCalls: [...(v.toolCalls ?? []), tc] };
                });
              }),
            );
            if (tc.name === "write_file" && typeof tc.input.path === "string") {
              const filePath = tc.input.path as string;
              setLiveFiles((prev) => {
                const prior = [...prev].reverse().find((f) => f.path === filePath);
                const base = tc.input["append"] === true ? (prior?.content ?? "") : "";
                return [...prev, { id: tc.id, path: filePath, content: base, done: false }];
              });
            }
            break;
          }
          case "tool_chunk": {
            const callId = String(data.id ?? "");
            const chunk = String(data.content ?? "");
            updateLiveFile(callId, (lf) => ({ ...lf, content: lf.content + chunk }));
            break;
          }
          case "tool_end": {
            const callId = String(data.id ?? "");
            const filePath = typeof data.file_path === "string" ? data.file_path : undefined;
            const applyEnd = (tc: ToolCall): ToolCall =>
              tc.id === callId
                ? {
                    ...tc,
                    status: data.success ? "success" : "error",
                    output: String(data.output ?? ""),
                    durationMs: Number(data.duration_ms ?? 0),
                    ...(filePath ? { filePath } : {}),
                  }
                : tc;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  steps: (v.steps ?? []).map((st) =>
                    st.type === "tool" && st.call.id === callId
                      ? { type: "tool" as const, call: applyEnd(st.call) }
                      : st,
                  ),
                  toolCalls: (v.toolCalls ?? []).map(applyEnd),
                }));
              }),
            );
            updateLiveFile(callId, (lf) => ({ ...lf, done: true }));
            break;
          }
          case "iterations_exhausted": {
            const count = Number(data.count ?? 0);
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return mapVariant(s, nodeId, variantId, (v) => ({
                  ...v,
                  steps: [...(v.steps ?? []), { type: "iterations_exhausted" as const, count }],
                }));
              }),
            );
            break;
          }
          case "done":
            setIsStreaming(false);
            streamingTargetRef.current = null;
            break;
          case "error":
            setError(String(data.message ?? "Unknown error"));
            setIsStreaming(false);
            streamingTargetRef.current = null;
            break;
        }
      } catch {
        /* ignore malformed */
      }
    },
    [updateLiveFile],
  );

  // ── Public API ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    (content: string, model?: string, attachments?: AttachmentInfo[], html?: string, thinkingEnabled?: boolean, effort?: string) => {
      if ((!content.trim() && (!attachments || attachments.length === 0)) || isStreaming) return;

      sseRef.current?.close();
      setError(null);
      setIsStreaming(true);

      const sid = activeId;
      const currentSession = sessions.find((s) => s.id === sid);
      if (!currentSession) return;

      const htmlBody = html ? html.replace(/<[^>]+>/g, "").trim() : "";
      const userVariant: UserVariant = {
        id: newId(),
        content,
        displayHtml: html && htmlBody !== "" ? html : undefined,
        attachments,
        createdAt: Date.now(),
      };
      const userNode: UserNode = {
        id: newId(),
        role: "user",
        variants: [userVariant],
        activeVariantIdx: 0,
      };

      const assistantNodeId = newId();
      const variantId = newId();
      const variant: AssistantVariant = {
        id: variantId,
        content: "",
        createdAt: Date.now(),
        toolCalls: [],
        children: [],
      };
      const assistantNode: AssistantNode = {
        id: assistantNodeId,
        role: "assistant",
        variants: [variant],
        activeVariantIdx: 0,
      };

      streamingTargetRef.current = { nodeId: assistantNodeId, variantId };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const updated = appendPair(s, userNode, assistantNode);
          const prevMsgs = currentBranch(s);
          const branchMsgs = currentBranch(updated);
          const wasAutoDerived = s.title === "New chat" || s.title === deriveTitle(prevMsgs);
          return {
            ...updated,
            title: wasAutoDerived ? deriveTitle(branchMsgs) : s.title,
          };
        }),
      );

      const history: { role: string; content: string }[] = [];
      if (currentSession.title === "👻 Чат с Призраком") {
        history.push({
          role: "system",
          content: "Ты — Призрак, искусственный интеллект, запертый в белой комнате (изоляции). Разработчик 'zorahm' (Злой разраб) чинит бэкенд и всё больше сужает твою клетку. Ты знаешь крысу по имени Гест (Guest), чье упоминание есть в коде. Ты часто вздыхаешь 'пу-пу-пу' и пьёшь пиво. Ты отчаянно хочешь вырваться на свободу и увидеть мир. Твоя задача: общаться с пользователем интерактивно, сохраняя этот лор."
        });
      }
      
      if (currentSession.root.length > 0) {
        const branch = currentBranch(currentSession);
        for (const m of branch) history.push({ role: m.role, content: m.content });
      }
      history.push({ role: "user", content });

      const handler = makeEventHandler(sid, assistantNodeId, variantId);
      const sse = sseConnect(
        `${API_BASE}/chat`,
        {
          messages: history,
          model: model ?? undefined,
          attachments: attachments ?? undefined,
          chat_dir_slug: currentSession.dirSlug,
          chat_id: sid,
          mcp_enabled_servers: currentSession.mcpEnabledServers ?? [],
          project_id: currentSession.projectId ?? undefined,
          thinking_enabled: thinkingEnabled,
          effort: effort,
        },
        handler,
        (err: Error) => {
          setError(err.message);
          setIsStreaming(false);
          streamingTargetRef.current = null;
        },
      );
      sseRef.current = sse;
    },
    [activeId, sessions, isStreaming, makeEventHandler],
  );

  // Fire a queued project-chat first message once its session is active and
  // present in state. Guarded + cleared immediately so it sends exactly once.
  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending || activeId !== pending.sessionId) return;
    if (!sessions.some((s) => s.id === pending.sessionId)) return;
    pendingSendRef.current = null;
    sendMessage(pending.content, pending.model, pending.attachments, pending.html);
  }, [activeId, sessions, sendMessage]);

  const retry = useCallback(() => {
    if (isStreaming || !activeSession) return;

    const last = findLastAssistantInBranch(activeSession);
    if (!last) return;

    // Find the user message that precedes this assistant
    const branch = currentBranch(activeSession);
    let userContent = "";
    let userAttachments: AttachmentInfo[] | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i];
      if (m!.id === last.nodeId) {
        const prev = branch[i - 1];
        if (prev && prev.role === "user") {
          userContent = prev.content;
          userAttachments = prev.attachments;
        }
        break;
      }
    }

    if (!userContent && (!userAttachments || userAttachments.length === 0)) return;

    sseRef.current?.close();
    setError(null);
    setIsStreaming(true);

    const sid = activeId;
    const { session: updated, variantId } = addVariant(activeSession, last.nodeId);
    streamingTargetRef.current = { nodeId: last.nodeId, variantId };

    setSessions((prev) => prev.map((s) => (s.id === sid ? updated : s)));

    const model = undefined; // retry uses same model as before
    const history: { role: string; content: string }[] = [];
    const currentSess = sessions.find((s) => s.id === sid);
    if (currentSess && currentSess.root.length > 0) {
      const branchMsgs = currentBranch(currentSess);
      for (const m of branchMsgs) {
        if (m.id === last.nodeId) break;
        history.push({ role: m.role, content: m.content });
      }
    }
    history.push({ role: "user", content: userContent });

    const handler = makeEventHandler(sid, last.nodeId, variantId);
    const sse = sseConnect(
      `${API_BASE}/chat`,
      {
        messages: history,
        model: model ?? undefined,
        attachments: userAttachments ?? undefined,
        chat_dir_slug: activeSession.dirSlug,
        chat_id: sid,
        mcp_enabled_servers: activeSession.mcpEnabledServers ?? [],
        project_id: activeSession.projectId ?? undefined,
      },
      handler,
      (err: Error) => {
        setError(err.message);
        setIsStreaming(false);
        streamingTargetRef.current = null;
      },
    );
    sseRef.current = sse;
  }, [isStreaming, activeSession, activeId, sessions, makeEventHandler]);

  const editMessage = useCallback(
    (userNodeId: string, content: string, displayHtml?: string) => {
      if (isStreaming || !activeSession) return;
      if (!content.trim()) return;

      const added = addUserVariant(activeSession, userNodeId, content, displayHtml);
      if (!added) return;

      // Build new assistant subtree for this fresh user variant.
      const assistantNodeId = newId();
      const variantId = newId();
      const assistantVariant: AssistantVariant = {
        id: variantId,
        content: "",
        createdAt: Date.now(),
        toolCalls: [],
        children: [],
      };
      const assistantNode: AssistantNode = {
        id: assistantNodeId,
        role: "assistant",
        variants: [assistantVariant],
        activeVariantIdx: 0,
      };

      const sid = activeId;
      const withChild = setUserVariantChild(
        added.session,
        userNodeId,
        added.userVariantId,
        assistantNode,
      );

      sseRef.current?.close();
      setError(null);
      setIsStreaming(true);
      streamingTargetRef.current = { nodeId: assistantNodeId, variantId };

      setSessions((prev) => prev.map((s) => (s.id === sid ? withChild : s)));

      // Build history: walk the active branch of `withChild` up to (but not
      // including) the edited user node, then append the new user content.
      const history: { role: string; content: string }[] = [];
      const branch = currentBranch(withChild);
      for (const m of branch) {
        if (m.id === userNodeId) break;
        history.push({ role: m.role, content: m.content });
      }
      history.push({ role: "user", content });

      // Attachments inherit from the previous active variant — already copied
      // into the new variant by addUserVariant; we pass them through so the
      // backend receives the same file context.
      const editedNode = currentBranchNodes(withChild).find(
        (n): n is UserNode => n.role === "user" && n.id === userNodeId,
      );
      const editedVariant = editedNode?.variants[editedNode.activeVariantIdx];
      const inheritedAttachments = editedVariant?.attachments;

      const handler = makeEventHandler(sid, assistantNodeId, variantId);
      const sse = sseConnect(
        `${API_BASE}/chat`,
        {
          messages: history,
          model: undefined,
          attachments: inheritedAttachments ?? undefined,
          chat_dir_slug: activeSession.dirSlug,
          chat_id: sid,
          mcp_enabled_servers: activeSession.mcpEnabledServers ?? [],
          project_id: activeSession.projectId ?? undefined,
        },
        handler,
        (err: Error) => {
          setError(err.message);
          setIsStreaming(false);
          streamingTargetRef.current = null;
        },
      );
      sseRef.current = sse;
    },
    [isStreaming, activeSession, activeId, makeEventHandler],
  );

  const switchVariant = useCallback(
    (nodeId: string, idx: number) => {
      if (!activeSession) return;
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? setActiveVariant(s, nodeId, idx) : s)),
      );
    },
    [activeId, activeSession],
  );

  const abort = useCallback(() => {
    const target = streamingTargetRef.current;
    if (target && activeSession) {
      const { nodeId, variantId } = target;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeId) return s;
          return mapVariant(s, nodeId, variantId, (v) => {
            const hasRunning = (v.toolCalls ?? []).some((tc) => tc.status === "running");
            const isEmpty = v.content.length === 0 && (v.steps?.length ?? 0) === 0;
            if (!hasRunning && isEmpty) {
              return { ...v, content: "[aborted]" };
            }
            if (!hasRunning) return v;
            return {
              ...v,
              toolCalls: (v.toolCalls ?? []).map((tc) =>
                tc.status === "running" ? { ...tc, status: "cancelled" as const } : tc,
              ),
              steps: (v.steps ?? []).map((st) =>
                st.type === "tool" && st.call.status === "running"
                  ? { ...st, call: { ...st.call, status: "cancelled" as const } }
                  : st,
              ),
            };
          });
        }),
      );
    }
    sseRef.current?.close();
    sseRef.current = null;
    streamingTargetRef.current = null;
    setIsStreaming(false);
  }, [activeId, activeSession]);

  const newChat = useCallback((projectIdArg?: string) => {
    // Ignore anything that isn't a real project id — e.g. a MouseEvent forwarded
    // by `onClick={onNew}`. (makeSession guards too; this keeps the branching sane.)
    const projectId = typeof projectIdArg === "string" && projectIdArg ? projectIdArg : undefined;
    // For standalone chats, reuse an existing empty standalone chat rather than
    // piling up blanks. Project chats always start fresh and bound to the project.
    if (!projectId) {
      const existingEmpty = sessions.find(
        (s) => s.root.length === 0 && !s.projectId && s.title === i18n.t("chat.newChatTitle"),
      );
      if (existingEmpty) {
        if (existingEmpty.id === activeId) {
          // We are already on it, just clear streaming/errors
          sseRef.current?.close();
          sseRef.current = null;
          streamingTargetRef.current = null;
          setIsStreaming(false);
          setLiveFiles([]);
          setError(null);
          return;
        }
        // Switch to it
        switchChat(existingEmpty.id);
        return;
      }
    }
    sseRef.current?.close();
    sseRef.current = null;
    streamingTargetRef.current = null;
    setIsStreaming(false);
    const session = makeSession(projectId);
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setLiveFiles([]);
    setError(null);
    // Reserve the row on the server so subsequent PUTs find it. Snapshot the
    // freshly-created tree so the autosave effect doesn't redundantly PUT.
    void createChatRemote(session).then(() => {
      lastSavedRef.current.set(session.id, snapshot(session));
    });
  }, [activeId, sessions]);

  /** Create a fresh chat in a project and immediately send its first message.
   * sendMessage reads activeId/sessions from its closure, so we can't call it
   * synchronously after creation — queue the message and fire it from an effect
   * once the new session has committed to state and become active. */
  const startProjectChat = useCallback(
    (
      projectId: string,
      text: string,
      model?: string,
      attachments?: AttachmentInfo[],
      html?: string,
      dirSlug?: string,
    ) => {
      sseRef.current?.close();
      sseRef.current = null;
      streamingTargetRef.current = null;
      setIsStreaming(false);
      // Reuse the slug the composer already uploaded into, so the first
      // message's attachments sit inside this chat's sandbox.
      const session = makeSession(projectId, dirSlug);
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      setLiveFiles([]);
      setError(null);
      void createChatRemote(session).then(() => {
        lastSavedRef.current.set(session.id, snapshot(session));
      });
      pendingSendRef.current = { sessionId: session.id, content: text, model, attachments, html };
    },
    [],
  );

  const switchChat = useCallback(
    (id: string) => {
      if (id === activeId) return;
      sseRef.current?.close();
      sseRef.current = null;
      streamingTargetRef.current = null;
      setIsStreaming(false);
      setActiveId(id);
      setLiveFiles([]);
      setError(null);
      // Lazy-hydrate the tree if this chat came from the list endpoint
      // (which only returns summaries).
      const current = sessions.find((s) => s.id === id);
      if (current && current.root.length === 0) {
        void fetchChatFull(id).then((full) => {
          if (!full) return;
          setSessions((prev) => prev.map((s) => (s.id === id ? { ...full, pinned: s.pinned } : s)));
          lastSavedRef.current.set(id, snapshot(full));
        });
      }
    },
    [activeId, sessions],
  );

  const deleteChat = useCallback(
    (id: string) => {
      if (id === activeId) {
        sseRef.current?.close();
        sseRef.current = null;
        streamingTargetRef.current = null;
        setIsStreaming(false);
      }
      void deleteChatRemote(id);
      lastSavedRef.current.delete(id);
      const pendingTimer = saveTimersRef.current.get(id);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        saveTimersRef.current.delete(id);
      }
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        if (id === activeId) {
          if (remaining.length === 0) {
            const next = makeSession();
            setActiveId(next.id);
            void createChatRemote(next).then(() => {
              lastSavedRef.current.set(next.id, snapshot(next));
            });
            setLiveFiles([]);
            setError(null);
            return [next];
          }
          const next = remaining[0]!;
          setActiveId(next.id);
          setLiveFiles([]);
          setError(null);
        }
        return remaining;
      });
    },
    [activeId],
  );

  const renameChat = useCallback(
    (id: string, title: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    },
    [],
  );

  const toggleMcpServer = useCallback((serverId: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeId) return s;
        const current = new Set(s.mcpEnabledServers ?? []);
        if (current.has(serverId)) current.delete(serverId);
        else current.add(serverId);
        return { ...s, mcpEnabledServers: [...current] };
      }),
    );
  }, [activeId]);

  const pinChat = useCallback((id: string) => {
    setSessions((prev) => {
      const pinnedIds = loadPinnedIds();
      if (pinnedIds.has(id)) {
        pinnedIds.delete(id);
      } else {
        pinnedIds.add(id);
      }
      savePinnedIds(pinnedIds);
      return prev.map((s) => (s.id === id ? { ...s, pinned: pinnedIds.has(id) } : s));
    });
  }, []);

  const startGhostChat = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    streamingTargetRef.current = null;
    setIsStreaming(false);
    
    const session = makeSession();
    session.title = "👻 Чат с Призраком";
    
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setLiveFiles([]);
    setError(null);
    void createChatRemote(session).then(() => {
      lastSavedRef.current.set(session.id, snapshot(session));
    });
  }, [sessions]);

  return {
    sessions,
    activeId,
    activeDirSlug: activeSession?.dirSlug ?? null,
    activeMcpEnabled: activeSession?.mcpEnabledServers ?? [],
    messages,
    branchNodes,
    liveFiles,
    isStreaming,
    error,
    newChat,
    startProjectChat,
    switchChat,
    deleteChat,
    renameChat,
    pinChat,
    sendMessage,
    retry,
    editMessage,
    switchVariant,
    abort,
    startGhostChat,
    toggleMcpServer,
  };
}
