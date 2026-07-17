/** Backend REST helpers for chat CRUD, plus snapshot/corruption diagnostics
 * shared by the save path. */

import type { ChatNode, ChatSession } from "../../types/chat";
import { API_BASE } from "../../utils/apiBase";
import { safeStringify } from "../../utils/safeJson";
import { MIGRATION_FLAG, migrateTreeNodes, readLocalSessions } from "./persistence";

interface ChatSummaryDTO {
  id: string;
  title: string;
  dir_slug: string;
  project_id?: string;
  agent_id?: string;
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
    agentId: s.agent_id || undefined,
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
    agentId: f.agent_id || undefined,
  };
}

export async function fetchChatList(): Promise<ChatSession[]> {
  try {
    const r = await fetch(`${API_BASE}/chats`);
    if (!r.ok) return [];
    const list = (await r.json()) as ChatSummaryDTO[];
    return list.map(summaryToSession);
  } catch {
    return [];
  }
}

export async function fetchChatFull(id: string): Promise<ChatSession | null> {
  try {
    const r = await fetch(`${API_BASE}/chats/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return fullToSession(await r.json());
  } catch {
    return null;
  }
}

export async function createChatRemote(s: ChatSession): Promise<ChatSession> {
  try {
    const { json, hadCycle } = safeStringify({
      id: s.id,
      title: s.title,
      dir_slug: s.dirSlug ?? "",
      root: s.root,
      created_at: s.createdAt,
      mcp_enabled: s.mcpEnabledServers ?? [],
      project_id: s.projectId ?? "",
      agent_id: s.agentId ?? "",
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

export async function putChatRemote(s: ChatSession): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      title: s.title,
      root: s.root,
      mcp_enabled: s.mcpEnabledServers ?? [],
      project_id: s.projectId ?? "",
      agent_id: s.agentId ?? "",
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

export async function deleteChatRemote(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* no-op */
  }
}

/** One-shot migration: drain localStorage chats into the SQLite backend. */
export async function maybeMigrateLocalStorage(): Promise<void> {
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
export function snapshot(s: ChatSession): string {
  const { json, hadCycle } = safeStringify({
    t: s.title,
    d: s.dirSlug ?? "",
    r: s.root,
    m: s.mcpEnabledServers ?? [],
    p: s.projectId ?? "",
    a: s.agentId ?? "",
  });
  if (hadCycle) warnCyclicTree("snapshot", s);
  return json;
}
