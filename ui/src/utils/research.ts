/** Research state: the reducer that turns `tool_progress` events into the tree
 *  the card and side panel render, plus shared source/domain helpers.
 *
 *  The event vocabulary is defined by backend/research/progress.py — a field
 *  added there has to be handled here or it is silently dropped. */

import type {
  ResearchAgent,
  ResearchAgentStatus,
  ResearchAgentStep,
  ResearchData,
  ResearchPlanStep,
  ResearchSource,
} from "../types/tool-call";

/** Agent id the backend reserves for the lead researcher. */
export const LEAD_AGENT_ID = "lead";

/** Bare hostname for a URL (www. stripped), best-effort. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

/** Favicon URL for a domain, as an Astryx `Citation` source icon.
 *  Google's service degrades to a generic globe for unknown domains, so a chip
 *  never ends up showing a broken image. */
export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

export interface SourceAgg {
  /** Unique source URLs. */
  total: number;
  /** Domains sorted by descending source count. */
  domains: { domain: string; count: number }[];
}

const URL_RE = /https?:\/\/[^\s)\]<>"']+/g;

/** Pull unique URLs out of a text blob (e.g. a web_search result string). */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.match(URL_RE) ?? []) {
    const url = m.replace(/[.,;)]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** Aggregate a flat URL list by domain, deduped by URL. */
export function aggregateUrls(urls: string[]): SourceAgg {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const domain = domainOf(url);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const domains = [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);
  return { total: seen.size, domains };
}

/** Every source any agent in the run touched. */
export function aggregateSources(data: ResearchData): SourceAgg {
  const urls: string[] = [];
  for (const agent of data.agents ?? []) {
    for (const source of agent.sources) urls.push(source.url);
  }
  return aggregateUrls(urls);
}

/** First non-empty line of the brief — a stand-in title while the run is still
 *  going and the report has none yet. */
export function briefTitle(brief: string): string {
  const line = brief.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120);
}

/** A fresh, empty run. */
export function emptyResearch(startedAt: number): ResearchData {
  return { status: "running", plan: [], agents: [], notes: [], startedAt };
}

/** Fill in fields a chat saved before the multi-agent rewrite doesn't have.
 *  Reloading an old chat must not blank the panel or throw on a missing array. */
export function normalizeResearch(data: ResearchData): ResearchData {
  if (data.plan && data.agents && data.notes) return data;
  return {
    ...data,
    plan: data.plan ?? [],
    agents: data.agents ?? [],
    notes: data.notes ?? [],
  };
}

/** Apply one structured tool_progress event onto the research state (immutable). */
export function applyResearchEvent(
  data: ResearchData,
  event: Record<string, unknown>,
): ResearchData {
  const state = normalizeResearch(data);
  const kind = String(event.kind ?? "");

  switch (kind) {
    case "plan":
      return { ...state, plan: readPlan(event.steps) };
    case "agent_start":
      return withAgent(state, String(event.agentId ?? ""), (agent) => ({
        ...agent,
        title: String(event.title ?? "") || agent.title,
        status: "running",
      }));
    case "agent_step": {
      const step = readStep(event);
      if (!step) return state;
      return withAgent(state, String(event.agentId ?? ""), (agent) => ({
        ...agent,
        steps: [...agent.steps, step],
      }));
    }
    case "agent_sources": {
      const urls = Array.isArray(event.urls) ? (event.urls as unknown[]).map(String) : [];
      if (urls.length === 0) return state;
      return withAgent(state, String(event.agentId ?? ""), (agent) => ({
        ...agent,
        sources: mergeSources(agent.sources, urls),
      }));
    }
    case "agent_end":
      return withAgent(state, String(event.agentId ?? ""), (agent) => ({
        ...agent,
        status: readStatus(event.status),
        summary: event.summary ? String(event.summary) : agent.summary,
      }));
    case "note": {
      const text = String(event.text ?? "").trim();
      return text ? { ...state, notes: [...state.notes, { text }] } : state;
    }
    case "done":
      return {
        ...state,
        title: event.title ? String(event.title) : state.title,
        reportPath: event.path ? String(event.path) : state.reportPath,
      };
    default:
      return state;
  }
}

/** Insert or update one agent, keeping arrival order (the lead arrives first). */
function withAgent(
  state: ResearchData,
  agentId: string,
  update: (agent: ResearchAgent) => ResearchAgent,
): ResearchData {
  if (!agentId) return state;
  const index = state.agents.findIndex((a) => a.id === agentId);
  const existing = index >= 0 ? state.agents[index] : undefined;
  const base: ResearchAgent = existing ?? {
    id: agentId,
    title: "",
    status: "running",
    steps: [],
    sources: [],
  };
  const next = update(base);
  const agents = [...state.agents];
  if (index >= 0) agents[index] = next;
  else agents.push(next);
  return { ...state, agents };
}

function mergeSources(current: ResearchSource[], urls: string[]): ResearchSource[] {
  const seen = new Set(current.map((s) => s.url));
  const added: ResearchSource[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    added.push({ url, domain: domainOf(url) });
  }
  return added.length > 0 ? [...current, ...added] : current;
}

function readPlan(raw: unknown): ResearchPlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: ResearchPlanStep[] = [];
  raw.forEach((item, i) => {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const title = String(record.title ?? "").trim();
      if (title) steps.push({ id: String(record.id ?? `s${i + 1}`), title });
    } else if (typeof item === "string" && item.trim()) {
      steps.push({ id: `s${i + 1}`, title: item.trim() });
    }
  });
  return steps;
}

function readStep(event: Record<string, unknown>): ResearchAgentStep | null {
  const value = String(event.value ?? "").trim();
  const step = String(event.step ?? "");
  if (step === "search") return { kind: "search", query: value };
  if (step === "read" && value) return { kind: "read", url: value };
  return null;
}

function readStatus(raw: unknown): ResearchAgentStatus {
  const value = String(raw ?? "");
  return value === "ok" || value === "failed" || value === "timeout" || value === "cancelled"
    ? value
    : "running";
}
