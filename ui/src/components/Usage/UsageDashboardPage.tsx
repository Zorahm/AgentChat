/** Usage/cost dashboard — summary, per-model breakdown, daily chart, top chats.
 * Rendered inside the main app grid so the shared Sidebar stays visible. */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChartBar, ChatCircle } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { API_BASE } from "../../utils/apiBase";

type Period = "day" | "week" | "month" | "all";

interface Summary {
  cost: number;
  tokens: number;
  calls: number;
}

interface ByModelRow {
  provider: string;
  model: string;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  calls: number;
}

interface DailyRow {
  day: string;
  provider: string;
  cost: number;
  tokens: number;
}

interface TopChatRow {
  chat_id: string;
  cost: number;
  calls: number;
  title: string | null;
}

interface Breakdown {
  system: number;
  memory: number;
  skills: number;
  tools: number;
  mcp_tools: number;
  history: number;
  message: number;
}

// Order matches roughly biggest-to-smallest in the common case. i18n keys are
// camelCase ("mcpTools") while the API/DB keys stay snake_case ("mcp_tools").
const BREAKDOWN_KEYS: readonly (keyof Breakdown)[] = [
  "system", "tools", "mcp_tools", "memory", "skills", "history", "message",
];
const BREAKDOWN_I18N_KEY: Record<keyof Breakdown, string> = {
  system: "system",
  memory: "memory",
  skills: "skills",
  tools: "tools",
  mcp_tools: "mcpTools",
  history: "history",
  message: "message",
};
const BREAKDOWN_COLORS: Record<keyof Breakdown, string> = {
  system: "#6366f1",
  tools: "#f59e0b",
  mcp_tools: "#0ea5e9",
  memory: "#a855f7",
  skills: "#14b8a6",
  history: "#22c55e",
  message: "#ec4899",
};

interface UsageDashboardPageProps {
  onGotoChat: (chatId: string) => void;
}

const PROVIDER_COLORS: readonly string[] = [
  "#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444",
];

function colorFor(provider: string, order: string[]): string {
  const idx = order.indexOf(provider);
  return PROVIDER_COLORS[idx % PROVIDER_COLORS.length] ?? "#888";
}

function fmtCost(cost: number | null): string {
  if (cost == null) return "—";
  return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

/** `row.model` is already the canonical "provider/model" id in most rows (see
 * backend/api/chat.py's usage_metadata) — prefixing `row.provider` again would
 * duplicate it (e.g. "anthropic/anthropic/claude-..."). Only prefix when the
 * model string doesn't already carry it (custom/manual pricing rows). */
function fullModelLabel(row: ByModelRow): string {
  return row.model.startsWith(`${row.provider}/`) ? row.model : `${row.provider}/${row.model}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export function UsageDashboardPage({ onGotoChat }: UsageDashboardPageProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("month");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [byModel, setByModel] = useState<ByModelRow[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [topChats, setTopChats] = useState<TopChatRow[]>([]);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchJson<Summary>(`/usage/summary?period=${period}`),
      fetchJson<ByModelRow[]>(`/usage/by-model?period=${period}`),
      fetchJson<DailyRow[]>(`/usage/daily?period=${period}`),
      fetchJson<TopChatRow[]>(`/usage/top-chats?period=${period}&limit=10`),
      fetchJson<Breakdown | null>(`/usage/breakdown?period=${period}`),
    ])
      .then(([s, m, d, c, b]) => {
        if (cancelled) return;
        setSummary(s);
        setByModel(m);
        setDaily(d);
        setTopChats(c);
        setBreakdown(b);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const breakdownTotal = useMemo(
    () => (breakdown ? BREAKDOWN_KEYS.reduce((sum, k) => sum + breakdown[k], 0) : 0),
    [breakdown],
  );

  const maxModelCost = useMemo(() => Math.max(1e-9, ...byModel.map((r) => r.cost)), [byModel]);

  const providers = useMemo(() => Array.from(new Set(daily.map((r) => r.provider))).sort(), [daily]);
  const days = useMemo(() => Array.from(new Set(daily.map((r) => r.day))).sort(), [daily]);
  const dayTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of daily) totals.set(row.day, (totals.get(row.day) ?? 0) + row.cost);
    return totals;
  }, [daily]);
  const maxDayCost = useMemo(() => Math.max(1e-9, ...Array.from(dayTotals.values())), [dayTotals]);

  return (
    <div className="usage-page">
      <header className="usage-head">
        <h1 className="usage-title"><ChartBar size={22} weight="duotone" /> {t("usage.title")}</h1>
        <div className="usage-period">
          {(["day", "week", "month", "all"] as Period[]).map((p) => (
            <Button
              key={p}
              label={t(`usage.period.${p}`)}
              variant={period === p ? "primary" : "secondary"}
              onClick={() => setPeriod(p)}
            />
          ))}
        </div>
      </header>

      <p className="usage-sub">{t("usage.description")}</p>

      {error && <div className="usage-error">{error}</div>}

      {!error && (
        <>
          <div className="usage-summary-cards">
            <SummaryCard label={t("usage.summary.cost")} value={fmtCost(summary?.cost ?? 0)} />
            <SummaryCard label={t("usage.summary.tokens")} value={fmtTokens(summary?.tokens ?? 0)} />
            <SummaryCard label={t("usage.summary.calls")} value={String(summary?.calls ?? 0)} />
          </div>

          <section className="usage-section">
            <h2 className="usage-section-title">{t("usage.byModel.title")}</h2>
            {byModel.length === 0 ? (
              <EmptyHint loading={loading} text={t("usage.byModel.empty")} />
            ) : (
              <div className="usage-model-bars">
                {byModel.map((row) => (
                  <div key={`${row.provider}/${row.model}`} className="usage-model-bar-row">
                    <div
                      className="usage-model-name"
                      title={fullModelLabel(row)}
                      data-full={fullModelLabel(row)}
                    >
                      <span className="usage-model-name-text">{row.model}</span>
                    </div>
                    <div className="usage-model-bar-track">
                      <div
                        className="usage-model-bar-fill"
                        style={{ width: `${Math.max(2, (row.cost / maxModelCost) * 100)}%` }}
                      />
                    </div>
                    <div className="usage-model-bar-meta">
                      {fmtCost(row.cost)} · {fmtTokens(row.prompt_tokens + row.completion_tokens)} {t("usage.byModel.tokensAbbrev")}
                      {row.cached_tokens > 0 && ` · ${fmtTokens(row.cached_tokens)} ${t("usage.byModel.cachedAbbrev")}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="usage-section">
            <h2 className="usage-section-title">{t("usage.breakdown.title")}</h2>
            <p className="usage-section-hint">{t("usage.breakdown.hint")}</p>
            {!breakdown || breakdownTotal === 0 ? (
              <EmptyHint loading={loading} text={t("usage.breakdown.empty")} />
            ) : (
              <>
                <div className="usage-breakdown-bar">
                  {BREAKDOWN_KEYS.map((k) => (
                    breakdown[k] > 0 ? (
                      <div
                        key={k}
                        className="usage-breakdown-seg"
                        style={{ width: `${(breakdown[k] / breakdownTotal) * 100}%`, background: BREAKDOWN_COLORS[k] }}
                        title={`${t(`usage.breakdown.${BREAKDOWN_I18N_KEY[k]}`)}: ${fmtTokens(breakdown[k])}`}
                      />
                    ) : null
                  ))}
                </div>
                <div className="usage-legend">
                  {BREAKDOWN_KEYS.filter((k) => breakdown[k] > 0).map((k) => (
                    <span key={k} className="usage-legend-item">
                      <span className="usage-legend-dot" style={{ background: BREAKDOWN_COLORS[k] }} />
                      {t(`usage.breakdown.${BREAKDOWN_I18N_KEY[k]}`)} · {fmtTokens(breakdown[k])} ({Math.round((breakdown[k] / breakdownTotal) * 100)}%)
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="usage-section">
            <h2 className="usage-section-title">{t("usage.daily.title")}</h2>
            {days.length === 0 ? (
              <EmptyHint loading={loading} text={t("usage.daily.empty")} />
            ) : (
              <>
                <div className="usage-chart">
                  {days.map((day) => {
                    const rows = daily.filter((r) => r.day === day);
                    const total = dayTotals.get(day) ?? 0;
                    return (
                      <div key={day} className="usage-chart-col" title={`${day}: ${fmtCost(total)}`}>
                        <div className="usage-chart-bar" style={{ height: `${Math.max(2, (total / maxDayCost) * 100)}%` }}>
                          {rows.map((r) => (
                            <div
                              key={r.provider}
                              className="usage-chart-seg"
                              style={{
                                height: `${(r.cost / (total || 1)) * 100}%`,
                                background: colorFor(r.provider, providers),
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="usage-legend">
                  {providers.map((p) => (
                    <span key={p} className="usage-legend-item">
                      <span className="usage-legend-dot" style={{ background: colorFor(p, providers) }} />
                      {p}
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="usage-section">
            <h2 className="usage-section-title">{t("usage.topChats.title")}</h2>
            {topChats.length === 0 ? (
              <EmptyHint loading={loading} text={t("usage.topChats.empty")} />
            ) : (
              <div className="usage-top-chats">
                {topChats.map((c) => (
                  <Button
                    key={c.chat_id}
                    label={c.title ?? t("usage.topChats.deletedChat")}
                    variant="ghost"
                    icon={<ChatCircle size={16} />}
                    onClick={() => onGotoChat(c.chat_id)}
                    isDisabled={!c.title}
                    width="100%"
                    className="usage-top-chat-row"
                  >
                    <span className="usage-top-chat-content">
                      <span className="usage-top-chat-title">{c.title ?? t("usage.topChats.deletedChat")}</span>
                      <span className="usage-top-chat-meta">
                        {fmtCost(c.cost)} · {c.calls} {t("usage.topChats.callsAbbrev")}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="usage-summary-card" padding={3}>
      <div className="usage-summary-value">{value}</div>
      <div className="usage-summary-label">{label}</div>
    </Card>
  );
}

function EmptyHint({ loading, text }: { loading: boolean; text: string }) {
  const { t } = useTranslation();
  return <div className="usage-empty">{loading ? t("usage.loading") : text}</div>;
}
