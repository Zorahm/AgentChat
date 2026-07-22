/** Research side panel — vertical timeline of a `research` run (plan → gathered
 *  sources with domain breakdown → search/read steps → report ready). Opened by
 *  clicking a ResearchCard; reuses the `art-panel` shell for sizing/resize. */

import { useTranslation } from "react-i18next";
import { X, MagnifyingGlass, FileText } from "@phosphor-icons/react";
import { IconButton } from "@astryxdesign/core/IconButton";
import type { ToolCall, ResearchStep } from "../../types/tool-call";
import { aggregateSources, domainOf } from "../../utils/research";
import { SourcesBox } from "./SourcesBox";

type TFn = (key: string, opts?: Record<string, unknown>) => string;

interface ResearchPanelProps {
  call: ToolCall;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function ResearchPanel({ call, onClose, onResizeStart }: ResearchPanelProps) {
  const { t } = useTranslation();
  const r = call.research;

  const agg = r ? aggregateSources(r) : { total: 0, domains: [] };
  const running = r ? r.status === "running" : false;
  const cancelled = r ? r.status === "cancelled" : false;
  const topic = typeof call.input?.topic === "string" ? call.input.topic : "";
  const title = r?.title || topic || t("chat.research.card.untitled");

  const steps = r?.steps ?? [];
  const planStep = steps.find((s): s is { kind: "plan"; text?: string } => s.kind === "plan");

  return (
    <aside className="art-panel research-panel">
      <div className="art-resize-handle" onMouseDown={onResizeStart} />

      <div className="rp-head">
        <span className="rp-head-title" title={title}>{title}</span>
        <IconButton
          label={t("artifacts.close")}
          icon={<X size={15} />}
          onClick={onClose}
          tooltip={t("artifacts.close")}
          size="sm"
          variant="ghost"
        />
      </div>

      <div className="rp-body">
        <ol className="rp-timeline">
          {planStep && (
            <li className="rp-node">
              <span className="rp-dot rp-dot--done" />
              <div className="rp-node-content">
                <span className="rp-node-label">{t("chat.research.panel.planCreated")}</span>
                {planStep.text && <span className="rp-plan-text">{planStep.text}</span>}
              </div>
            </li>
          )}

          {agg.total > 0 && (
            <li className="rp-node">
              <span className="rp-dot rp-dot--done" />
              <div className="rp-node-content">
                <span className="rp-node-label">
                  {t("chat.research.panel.gathered", { count: agg.total })}
                </span>
                <SourcesBox agg={agg} />
              </div>
            </li>
          )}

          {steps.map((step, i) => (
            <StepNode key={i} step={step} t={t} />
          ))}

          {running && (
            <li className="rp-node rp-node--active">
              <span className="rp-dot rp-dot--active" />
              <span className="rp-node-label">{t("chat.research.panel.working")}</span>
            </li>
          )}
          {cancelled && (
            <li className="rp-node">
              <span className="rp-dot rp-dot--cancelled" />
              <span className="rp-node-label rp-node-label--cancelled">
                {t("chat.research.panel.cancelled")}
              </span>
            </li>
          )}
          {!running && !cancelled && (
            <li className="rp-node">
              <span className="rp-dot rp-dot--done" />
              <span className="rp-node-label rp-node-label--ready">
                {t("chat.research.panel.reportReady")}
              </span>
            </li>
          )}
        </ol>
      </div>
    </aside>
  );
}

function StepNode({ step, t }: { step: ResearchStep; t: TFn }) {
  if (step.kind === "plan") return null;

  if (step.kind === "search") {
    const count = step.sources.length;
    return (
      <li className="rp-node">
        <span className="rp-dot" />
        <div className="rp-node-content">
          <span className="rp-node-label rp-node-label--query">
            <MagnifyingGlass size={13} weight="bold" />
            <span>{step.query || t("chat.research.panel.searching")}</span>
          </span>
          {count > 0 && (
            <span className="rp-step-count">{t("chat.research.card.sources", { count })}</span>
          )}
        </div>
      </li>
    );
  }

  return (
    <li className="rp-node">
      <span className="rp-dot" />
      <span className="rp-node-label rp-node-label--read">
        <FileText size={13} weight="bold" />
        <span>{domainOf(step.url)}</span>
      </span>
    </li>
  );
}
