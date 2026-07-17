/** localStorage persistence, legacy-session migration, and session creation. */

import type {
  ChatMessage,
  ChatNode,
  ChatSession,
  UserNode,
  UserVariant,
  AssistantNode,
  AssistantVariant,
  AttachmentInfo,
} from "../../types/chat";
import { i18n } from "../../i18n";

// ── Sticky composer defaults ────────────────────────────────────────────────

// Web-search toggle is a sticky user preference: the last enabled/mode the user
// picked seeds every new chat, instead of resetting to off/auto each time.
export interface WebSearchPref {
  enabled: boolean;
  mode: string;
}

// Sticky web-search default. Mirrors the backend setting (web_search_enabled /
// web_search_mode) so the toggle survives restarts and is shared across devices
// — no localStorage. The hook owns the *reactive* copy (so the composer
// re-renders when settings load); this module-level mirror exists so makeSession
// (module scope) and the send path can read the latest value synchronously
// without threading it through. Kept in sync from hook state via an effect.
let webSearchDefault: WebSearchPref = { enabled: false, mode: "auto" };

// Sticky research toggle default — same rationale as webSearchDefault above
// (mirrored from the persisted research_enabled setting, read synchronously by
// makeSession + the send path).
let researchDefault = false;

// Sticky thinking / reasoning-effort mirror. App pushes the live composer
// toggles here so the send path AND retry/editMessage (which run inside the hook,
// away from App's state) reuse the reasoning preferences the user actually
// picked. Without this, a retry/edit silently drops to the model's default
// thinking/effort — a desync between the toggle on screen and how the model runs.
let thinkingDefault = true;
let effortDefault: string | null = null;

export function getWebSearchDefault(): WebSearchPref {
  return webSearchDefault;
}
export function setWebSearchDefaultState(v: WebSearchPref): void {
  webSearchDefault = v;
}
export function getResearchDefault(): boolean {
  return researchDefault;
}
export function setResearchDefaultState(v: boolean): void {
  researchDefault = v;
}
export function getThinkingDefault(): boolean {
  return thinkingDefault;
}
export function setThinkingDefaultState(v: boolean): void {
  thinkingDefault = v;
}
export function getEffortDefault(): string | null {
  return effortDefault;
}
export function setEffortDefaultState(v: string | null): void {
  effortDefault = v;
}

// ── Pinned chats ────────────────────────────────────────────────────────────

const PINNED_KEY = "aic-pinned-v1";

export function loadPinnedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

export function savePinnedIds(ids: Set<string>): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...ids]));
}

export const STORAGE_KEY = "aic-sessions-v2";
export const OLD_STORAGE_KEY = "aic-sessions-v1";
export const MIGRATION_FLAG = "aic-migration-v3-done";
export const SAVE_DEBOUNCE_MS = 1500;

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
export function migrateTreeNodes(raw: unknown): ChatNode[] {
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
    // Must be carried through explicitly — any field omitted here is silently
    // dropped on every chat reload. Losing it would re-enable the legacy
    // "content looks like HTML" rendering heuristic for plain-text messages.
    plainText: raw.plainText as boolean | undefined,
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
      // Preserve the web-search badge across reloads. Omitting this dropped the
      // indicator (and the native-search chip) every time a chat was rehydrated
      // from the backend, even though the value was saved in the tree.
      webSearchMode: v.webSearchMode as string | undefined,
      // Same story as webSearchMode above — carry the cost/token line through
      // reload instead of dropping it silently on every rehydration.
      usage: v.usage as AssistantVariant["usage"],
      createdAt: Number(v.createdAt ?? Date.now()),
      children: migrateTreeNodes(v.children),
    })),
    activeVariantIdx: raw.activeVariantIdx ?? 0,
  };
}

/** Read sessions from localStorage. Used only by the one-shot migration to
 * SQLite — after migration the backend is the source of truth. */
export function readLocalSessions(): ChatSession[] {
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

/** Optional composer-toggle seed for a freshly spawned chat (used by the
 *  project composer, which sets web-search/research/MCP before the chat
 *  exists). Any field left out falls back to the sticky module default. */
export interface SessionSeed {
  webSearchEnabled?: boolean;
  webSearchMode?: string;
  researchEnabled?: boolean;
  mcpEnabledServers?: string[];
}

export function makeSession(projectId?: string, dirSlug?: string, seed?: SessionSeed): ChatSession {
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
    // Seed from the explicit composer toggles when provided, else from the
    // sticky web-search default (mirrored from settings) so the toggle
    // persists across new chats and app restarts.
    webSearchEnabled: seed?.webSearchEnabled ?? webSearchDefault.enabled,
    webSearchMode: seed?.webSearchMode ?? webSearchDefault.mode,
    researchEnabled: seed?.researchEnabled ?? researchDefault,
    ...(seed?.mcpEnabledServers && seed.mcpEnabledServers.length
      ? { mcpEnabledServers: seed.mcpEnabledServers }
      : {}),
  };
}

export function deriveTitle(msgs: ChatMessage[]): string {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return i18n.t("chat.newChatTitle");
  const t = first.content.replace(/\s+/g, " ").trim();
  return t.length > 50 ? t.slice(0, 48) + "…" : t;
}

/** Node/variant ids are persisted with the chat tree, so they must be unique
 * across page reloads — a session-scoped counter reset to 1 on every load and
 * collided with ids already in the tree (mis-targeting variant switches and
 * token streaming). randomUUID needs a secure context, which remote HTTP
 * clients (phone over LAN/Tailscale) don't have — hence the fallback. */
export const newId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** True when a chat still carries an auto-assigned "new chat" title — in any
 * locale, plus the pre-i18n literal — i.e. the user never renamed it. Title
 * auto-derivation must keep working after the user switches languages. */
export function isDefaultTitle(title: string): boolean {
  if (title === "New chat") return true; // pre-i18n builds stored the literal
  const langs = Object.keys(i18n.services.resourceStore?.data ?? {});
  return langs.some((lng) => i18n.getFixedT(lng)("chat.newChatTitle") === title);
}
