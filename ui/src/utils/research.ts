/** Helpers for the research card + side panel: domain extraction, source
 *  aggregation, and applying live tool_progress events to ResearchData. */

import type { ResearchData, ResearchSource } from "../types/tool-call";

/** Bare hostname for a URL (www. stripped), best-effort. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
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

/** Aggregate every research source (search results + read pages). */
export function aggregateSources(data: ResearchData): SourceAgg {
  const urls: string[] = [];
  for (const step of data.steps) {
    if (step.kind === "search") urls.push(...step.sources.map((s) => s.url));
    else if (step.kind === "read") urls.push(step.url);
  }
  return aggregateUrls(urls);
}

/** Apply one structured tool_progress event onto the research state (immutable). */
export function applyResearchEvent(
  data: ResearchData,
  event: Record<string, unknown>,
): ResearchData {
  const kind = String(event.kind ?? "");

  if (kind === "plan") {
    const text = event.text ? String(event.text) : undefined;
    const idx = data.steps.findIndex((s) => s.kind === "plan");
    if (idx >= 0) {
      if (!text) return data;
      const steps = [...data.steps];
      steps[idx] = { kind: "plan", text };
      return { ...data, steps };
    }
    return { ...data, steps: [...data.steps, { kind: "plan", text }] };
  }

  if (kind === "search") {
    const query = String(event.query ?? "");
    const callId = event.callId ? String(event.callId) : undefined;
    return { ...data, steps: [...data.steps, { kind: "search", query, sources: [], callId }] };
  }

  if (kind === "sources") {
    const urls = Array.isArray(event.urls) ? (event.urls as unknown[]).map(String) : [];
    const sources: ResearchSource[] = urls.map((url) => ({ url, domain: domainOf(url) }));
    const callId = event.callId ? String(event.callId) : undefined;
    const steps = [...data.steps];
    // Prefer the search step with the matching call id (the model can fire
    // several searches in one turn); fall back to the most recent search.
    let idx = callId
      ? steps.findIndex((s) => s.kind === "search" && s.callId === callId)
      : -1;
    if (idx < 0) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i]!.kind === "search") { idx = i; break; }
      }
    }
    const target = idx >= 0 ? steps[idx] : undefined;
    if (target && target.kind === "search") {
      steps[idx] = { ...target, sources: [...target.sources, ...sources] };
      return { ...data, steps };
    }
    return data;
  }

  if (kind === "read") {
    const url = String(event.url ?? "");
    if (!url) return data;
    return { ...data, steps: [...data.steps, { kind: "read", url }] };
  }

  if (kind === "done") {
    return { ...data, title: event.title ? String(event.title) : data.title };
  }

  return data;
}
