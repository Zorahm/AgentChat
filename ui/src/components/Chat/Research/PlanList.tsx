/** The lead researcher's plan — the sub-questions it published via `plan_research`. */

import { useTranslation } from "react-i18next";
import type { ResearchPlanStep } from "../../../types/tool-call";

interface PlanListProps {
  steps: ResearchPlanStep[];
}

export function PlanList({ steps }: PlanListProps) {
  const { t } = useTranslation();
  if (steps.length === 0) return null;

  return (
    <div className="rp-plan">
      <span className="rp-node-label">{t("chat.research.panel.planCreated")}</span>
      <ol className="rp-plan-steps">
        {steps.map((step) => (
          <li key={step.id} className="rp-plan-step">
            {step.title}
          </li>
        ))}
      </ol>
    </div>
  );
}
