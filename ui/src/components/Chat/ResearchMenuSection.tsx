/** Research toggle, rendered as a section inside the composer "+" menu.
 *
 * Mirrors WebSearchMenuSection but without a mode picker — research is a plain
 * on/off switch. When on, the backend wires the `research` tool for the turn. */

import { Flask, Check } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

interface ResearchMenuSectionProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export function ResearchMenuSection({ enabled, onChange }: ResearchMenuSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="cpm-section">
      <button
        className={`cpm-item cpm-item--toggle${enabled ? " cpm-item--on" : ""}`}
        onClick={() => onChange(!enabled)}
        title={t("chat.research.hint")}
      >
        <Flask />
        <span className="cpm-item-label">{t("chat.research.toggle")}</span>
        {enabled && <Check className="cpm-check" weight="bold" />}
      </button>
    </div>
  );
}
