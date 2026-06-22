/** Research card — compact summary of a `research` run, shown in the chat flow.
 *  Clicking it opens the research side panel (timeline of the process). */

import { useTranslation } from "react-i18next";
import { CaretRight, MagnifyingGlass, Spinner } from "@phosphor-icons/react";
import type { ToolCall } from "../../types/tool-call";
import { aggregateSources } from "../../utils/research";

interface ResearchCardProps {
  call: ToolCall;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ResearchCard({ call }: ResearchCardProps) {
  const { t } = useTranslation();
  const r = call.research;
  if (!r) return null;

  const { total } = aggregateSources(r);
  const running = r.status === "running";
  const cancelled = r.status === "cancelled";
  const topic = typeof call.input?.topic === "string" ? call.input.topic : "";
  const title = r.title || topic || t("chat.research.card.untitled");
  const duration = r.durationMs ?? 0;

  const statusText = cancelled
    ? t("chat.research.card.cancelled")
    : running
      ? t("chat.research.card.running")
      : t("chat.research.card.complete");

  const open = (): void => {
    window.dispatchEvent(new CustomEvent("open-research", { detail: call.id }));
  };

  return (
    <button
      className={`research-card${running ? " research-card--running" : ""}${cancelled ? " research-card--cancelled" : ""}`}
      onClick={open}
    >
      <span className="research-card-ic">
        {running ? <Spinner className="research-spin" weight="bold" /> : <MagnifyingGlass weight="bold" />}
      </span>
      <span className="research-card-body">
        <span className="research-card-title">{title}</span>
        <span className="research-card-meta">
          <span>{statusText}</span>
          {total > 0 && <span> · {t("chat.research.card.sources", { count: total })}</span>}
          {!running && !cancelled && duration > 0 && <span> · {fmtDuration(duration)}</span>}
        </span>
      </span>
      <CaretRight className="research-card-chev" weight="bold" />
    </button>
  );
}
