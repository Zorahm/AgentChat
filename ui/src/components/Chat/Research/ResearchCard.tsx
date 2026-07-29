/** Research card — compact summary of a `research` run, shown in the chat flow.
 *  Clicking it opens the research side panel (the tree of the process).
 *
 *  ClickableCard owns the surface and the click; Item owns the
 *  icon / title / meta / chevron row. Laying this out by hand inside an Astryx
 *  component does not work — Button and friends wrap `children` in their own
 *  flex wrappers, so our flex rules land on the wrapper and the children stack
 *  vertically and overflow the pill. Let the components do the layout. */

import { useTranslation } from "react-i18next";
import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Item } from "@astryxdesign/core/Item";
import { Spinner } from "@astryxdesign/core/Spinner";
import type { ToolCall } from "../../../types/tool-call";
import {
  LEAD_AGENT_ID,
  aggregateSources,
  briefTitle,
  normalizeResearch,
} from "../../../utils/research";

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
  if (!call.research) return null;
  const research = normalizeResearch(call.research);

  const { total } = aggregateSources(research);
  const running = research.status === "running";
  const cancelled = research.status === "cancelled";
  const brief = typeof call.input?.brief === "string" ? call.input.brief : "";
  const title = research.title || briefTitle(brief) || t("chat.research.card.untitled");
  const duration = research.durationMs ?? 0;
  const agentCount = research.agents.filter((a) => a.id !== LEAD_AGENT_ID).length;

  const meta = [
    cancelled
      ? t("chat.research.card.cancelled")
      : running
        ? t("chat.research.card.running")
        : t("chat.research.card.complete"),
    ...(agentCount > 0 ? [t("chat.research.card.agents", { count: agentCount })] : []),
    ...(total > 0 ? [t("chat.research.card.sources", { count: total })] : []),
    ...(!running && !cancelled && duration > 0 ? [fmtDuration(duration)] : []),
  ].join(" · ");

  const open = (): void => {
    window.dispatchEvent(new CustomEvent("open-research", { detail: call.id }));
  };

  return (
    <ClickableCard
      label={title}
      onClick={open}
      padding={2}
      width="100%"
      className={`research-card${cancelled ? " research-card--cancelled" : ""}`}
    >
      <Item
        label={title}
        description={meta}
        labelLines={1}
        descriptionLines={1}
        startContent={
          <span className="research-card-ic">
            {running ? <Spinner size="sm" /> : <MagnifyingGlass weight="bold" />}
          </span>
        }
        endContent={<CaretRight className="research-card-chev" weight="bold" />}
      />
    </ClickableCard>
  );
}
