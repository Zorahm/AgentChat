/** One agent in the research tree — the lead or a subagent — with its own steps.
 *
 *  Collapsed by default: a four-subagent run produces far more steps than fit on
 *  screen, and the useful glance is "who is working on what, and how far along". */

import { useState } from "react";
import {
  CaretRight,
  CheckCircle,
  Clock,
  MagnifyingGlass,
  Prohibit,
  WarningCircle,
} from "@phosphor-icons/react";
import { Citation } from "@astryxdesign/core/Citation";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useTranslation } from "react-i18next";
import type { ResearchAgent, ResearchAgentStep } from "../../../types/tool-call";
import { LEAD_AGENT_ID, domainOf, faviconUrl } from "../../../utils/research";

interface AgentNodeProps {
  agent: ResearchAgent;
}

export function AgentNode({ agent }: AgentNodeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const isLead = agent.id === LEAD_AGENT_ID;
  const title = agent.title || (isLead ? t("chat.research.panel.leadAgent") : agent.id);
  const hasDetail = agent.steps.length > 0 || !!agent.summary;

  // The lead's node is noise until it has actually done something itself — its
  // real output is the plan and the report, which the panel shows separately.
  if (isLead && !hasDetail && agent.status !== "failed") return null;

  return (
    <li className={`rp-agent rp-agent--${agent.status}`}>
      <button
        type="button"
        className="rp-agent-head"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasDetail}
        aria-expanded={open}
      >
        <StatusIcon status={agent.status} />
        <span className="rp-agent-title">{title}</span>
        {agent.sources.length > 0 && (
          <span className="rp-agent-count">
            {t("chat.research.card.sources", { count: agent.sources.length })}
          </span>
        )}
        {hasDetail && (
          <CaretRight
            className={`rp-agent-chev${open ? " rp-agent-chev--open" : ""}`}
            weight="bold"
          />
        )}
      </button>

      {open && (
        <div className="rp-agent-body">
          {agent.steps.map((step, i) => (
            <StepRow key={i} step={step} index={i + 1} />
          ))}
          {agent.summary && <p className="rp-agent-summary">{agent.summary}</p>}
        </div>
      )}
    </li>
  );
}

function StepRow({ step, index }: { step: ResearchAgentStep; index: number }) {
  const { t } = useTranslation();
  if (step.kind === "search") {
    return (
      <span className="rp-agent-step">
        <MagnifyingGlass size={13} weight="bold" />
        <span>{step.query || t("chat.research.panel.searching")}</span>
      </span>
    );
  }
  // A page the agent actually opened is a source, so it gets the same chip
  // treatment as the gathered-sources list.
  const domain = domainOf(step.url);
  return (
    <span className="rp-agent-step rp-agent-step--read">
      <Citation
        number={index}
        variant="label"
        source={{ title: domain, url: step.url, icon: faviconUrl(domain) }}
      />
    </span>
  );
}

function StatusIcon({ status }: { status: ResearchAgent["status"] }) {
  if (status === "running") return <Spinner size="sm" />;
  if (status === "ok") return <CheckCircle size={15} weight="fill" className="rp-agent-ic--ok" />;
  if (status === "timeout") return <Clock size={15} weight="fill" className="rp-agent-ic--warn" />;
  if (status === "cancelled") {
    return <Prohibit size={15} weight="fill" className="rp-agent-ic--muted" />;
  }
  return <WarningCircle size={15} weight="fill" className="rp-agent-ic--fail" />;
}
