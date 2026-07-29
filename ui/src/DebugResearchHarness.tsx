/** TEMPORARY debug harness for visually verifying the research card + the
 * multi-agent panel tree. Not part of the app — rendered only behind
 * ?debug-research, since a real run needs a provider, a web backend and minutes.
 * Builds its state by replaying real tool_progress events through the reducer,
 * so what you see is exactly what a live run would produce. */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { ResearchCard } from "./components/Chat/Research/ResearchCard";
import { ResearchPanel } from "./components/Chat/Research/ResearchPanel";
import type { ToolCall } from "./types/tool-call";
import { applyResearchEvent, emptyResearch } from "./utils/research";

const EVENTS: Record<string, unknown>[] = [
  { kind: "agent_start", agentId: "lead", title: "" },
  {
    kind: "plan",
    steps: [
      { id: "s1", title: "Текущее состояние рынка и ключевые игроки" },
      { id: "s2", title: "Бенчмарки и независимые сравнения" },
      { id: "s3", title: "Открытые проблемы и критика" },
    ],
  },
  { kind: "note", text: "Три угла независимы — запускаю их параллельно." },
  { kind: "agent_start", agentId: "a1", title: "Состояние рынка" },
  { kind: "agent_start", agentId: "a2", title: "Бенчмарки" },
  { kind: "agent_start", agentId: "a3", title: "Критика и открытые проблемы" },
  { kind: "agent_step", agentId: "a1", step: "search", value: "рынок ИИ-агентов 2026 доля" },
  {
    kind: "agent_sources",
    agentId: "a1",
    urls: ["https://example.com/market", "https://arxiv.org/abs/2601.001"],
  },
  { kind: "agent_step", agentId: "a1", step: "read", value: "https://example.com/market" },
  { kind: "agent_step", agentId: "a2", step: "search", value: "agent benchmark leaderboard" },
  { kind: "agent_sources", agentId: "a2", urls: ["https://arxiv.org/abs/2601.002"] },
  {
    kind: "agent_end",
    agentId: "a1",
    status: "ok",
    sources: 2,
    summary: "Рынок консолидируется вокруг трёх поставщиков; доля остальных падает второй год.",
  },
  { kind: "agent_end", agentId: "a2", status: "ok", sources: 1, summary: "Лидерборды расходятся." },
  { kind: "agent_end", agentId: "a3", status: "timeout" },
  { kind: "agent_step", agentId: "lead", step: "search", value: "проверка спорной цифры 47%" },
  { kind: "agent_sources", agentId: "lead", urls: ["https://example.com/check"] },
  { kind: "note", text: "Один субагент не уложился в лимит — закрываю угол сам." },
];

function build(upTo: number): ToolCall {
  let data = emptyResearch(Date.now() - 214_000);
  for (const event of EVENTS.slice(0, upTo)) data = applyResearchEvent(data, event);
  return {
    id: `dbg-${upTo}`,
    name: "research",
    input: { brief: "Состояние рынка ИИ-агентов в 2026 году" },
    status: "running",
    research: data,
  };
}

const running = build(EVENTS.length);

const finished = ((): ToolCall => {
  const call = build(EVENTS.length);
  const data = applyResearchEvent(call.research!, {
    kind: "done",
    title: "Рынок ИИ-агентов: состояние на 2026",
    path: "/home/u/chats/c1/research-rynok-ii-agentov.md",
  });
  return {
    ...call,
    id: "dbg-done",
    status: "success",
    research: { ...data, status: "complete", durationMs: 214_000 },
  };
})();

const cancelled: ToolCall = {
  ...running,
  id: "dbg-cancelled",
  status: "cancelled",
  research: { ...running.research!, status: "cancelled" },
};

/** Old chats were saved before the multi-agent rewrite and have none of the new
 *  arrays — the card and panel must render instead of throwing. */
const legacy = {
  id: "dbg-legacy",
  name: "research",
  input: { topic: "Старый чат до переписывания" },
  status: "success",
  research: { status: "complete", startedAt: Date.now(), durationMs: 90_000 },
} as unknown as ToolCall;

export function DebugResearchHarness() {
  return (
    <Theme theme={neutralTheme}>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
        <h2>Research cards</h2>
        <ResearchCard call={running} />
        <ResearchCard call={finished} />
        <ResearchCard call={cancelled} />
        <ResearchCard call={legacy} />

        <h2>Panel — running</h2>
        <div style={{ position: "relative", height: 520, width: 420, border: "1px solid #ccc" }}>
          <ResearchPanel call={running} onClose={() => {}} onResizeStart={() => {}} />
        </div>

        <h2>Panel — legacy chat</h2>
        <div style={{ position: "relative", height: 220, width: 420, border: "1px solid #ccc" }}>
          <ResearchPanel call={legacy} onClose={() => {}} onResizeStart={() => {}} />
        </div>
      </div>
    </Theme>
  );
}
