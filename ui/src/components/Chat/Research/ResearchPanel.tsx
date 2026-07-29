/** Research side panel — the tree of a `research` run: plan → the lead's notes →
 *  one collapsible node per agent → report ready. Opened by clicking a
 *  ResearchCard; reuses the `art-panel` shell for sizing/resize. */

import { useTranslation } from "react-i18next";
import { X } from "@phosphor-icons/react";
import { IconButton } from "@astryxdesign/core/IconButton";
import type { ToolCall } from "../../../types/tool-call";
import { aggregateSources, briefTitle, normalizeResearch } from "../../../utils/research";
import { SourcesBox } from "../SourcesBox";
import { AgentNode } from "./AgentNode";
import { PlanList } from "./PlanList";

interface ResearchPanelProps {
  call: ToolCall;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function ResearchPanel({ call, onClose, onResizeStart }: ResearchPanelProps) {
  const { t } = useTranslation();
  const research = call.research ? normalizeResearch(call.research) : null;

  const agg = research ? aggregateSources(research) : { total: 0, domains: [] };
  const running = research?.status === "running";
  const cancelled = research?.status === "cancelled";
  const brief = typeof call.input?.brief === "string" ? call.input.brief : "";
  const title = research?.title || briefTitle(brief) || t("chat.research.card.untitled");

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
        <PlanList steps={research?.plan ?? []} />

        {(research?.notes.length ?? 0) > 0 && (
          <ul className="rp-notes">
            {research?.notes.map((note, i) => (
              <li key={i} className="rp-note">{note.text}</li>
            ))}
          </ul>
        )}

        {agg.total > 0 && (
          <div className="rp-gathered">
            <span className="rp-node-label">
              {t("chat.research.panel.gathered", { count: agg.total })}
            </span>
            <SourcesBox agg={agg} />
          </div>
        )}

        <ul className="rp-agents">
          {research?.agents.map((agent) => <AgentNode key={agent.id} agent={agent} />)}
        </ul>

        <div className="rp-status">
          {running && (
            <span className="rp-node-label">{t("chat.research.panel.working")}</span>
          )}
          {cancelled && (
            <span className="rp-node-label rp-node-label--cancelled">
              {t("chat.research.panel.cancelled")}
            </span>
          )}
          {!running && !cancelled && (
            <span className="rp-node-label rp-node-label--ready">
              {t("chat.research.panel.reportReady")}
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
