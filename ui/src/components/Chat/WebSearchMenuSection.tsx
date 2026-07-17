/** Web search toggle + mode picker, rendered as a section inside the composer "+" menu. */

import { useEffect, useState } from "react";
import { Globe, Check, CaretDown } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { API_BASE } from "../../utils/apiBase";

type ModeId = "auto" | "native" | "litellm" | "searxng";

interface ModeStatus {
  id: ModeId;
  available: boolean;
  reason: string;
}

interface WebSearchMenuSectionProps {
  enabled: boolean;
  mode: string;
  onChange: (enabled: boolean, mode?: string) => void;
}

const MODE_ORDER: ModeId[] = ["auto", "native", "litellm", "searxng"];

export function WebSearchMenuSection({ enabled, mode, onChange }: WebSearchMenuSectionProps) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<ModeStatus[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/config/web-search`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { modes?: ModeStatus[] } | null) => {
        if (!cancelled && d?.modes) setStatuses(d.modes);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const available = (id: ModeId): boolean =>
    id === "auto" || (statuses.find((s) => s.id === id)?.available ?? false);
  const reason = (id: ModeId): string => statuses.find((s) => s.id === id)?.reason ?? "";
  const label = (id: string): string => t(`chat.webSearch.modes.${id}`, { defaultValue: id });

  return (
    <div className="cpm-section">
      <div className="cpm-ws-row">
        <button
          className={`cpm-item cpm-item--toggle${enabled ? " cpm-item--on" : ""}`}
          onClick={() => onChange(!enabled, mode)}
        >
          <Globe />
          <span className="cpm-item-label">{t("chat.webSearch.toggle")}</span>
          {enabled && <Check className="cpm-check" weight="bold" />}
        </button>
        <button
          className={`cpm-caret${expanded ? " cpm-caret--open" : ""}`}
          title={t("chat.webSearch.settings")}
          onClick={() => setExpanded((v) => !v)}
        >
          <CaretDown size={14} />
        </button>
      </div>

      {expanded && (
        <div className="cpm-sub">
          {MODE_ORDER.map((id) => {
            const ok = available(id);
            return (
              <button
                key={id}
                className={`cpm-subitem${mode === id ? " sel" : ""}`}
                disabled={!ok}
                title={id === "auto" ? t("chat.webSearch.autoHint") : reason(id)}
                onClick={() => onChange(true, id)}
              >
                <span className="cpm-sub-label">{label(id)}</span>
                {id !== "auto" && !ok && <span className="cpm-sub-reason">{reason(id)}</span>}
                {mode === id && <Check className="cpm-check" weight="bold" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
