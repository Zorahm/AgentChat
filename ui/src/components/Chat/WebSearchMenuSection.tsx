/** Web search toggle + mode picker, rendered as a section inside the composer "+" menu. */

import { useEffect, useState } from "react";
import { Globe, Check, CaretDown } from "@phosphor-icons/react";
import { DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
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
        <DropdownMenuItem
          icon={<Globe />}
          label={t("chat.webSearch.toggle")}
          onClick={() => onChange(!enabled, mode)}
          endContent={enabled ? <Check className="cpm-check" weight="bold" /> : undefined}
          className={`cpm-item cpm-item--toggle${enabled ? " cpm-item--on" : ""}`}
        />
        <IconButton
          label={t("chat.webSearch.settings")}
          icon={<CaretDown size={14} />}
          onClick={() => setExpanded((v) => !v)}
          tooltip={t("chat.webSearch.settings")}
          variant="ghost"
          size="sm"
          className={`cpm-caret${expanded ? " cpm-caret--open" : ""}`}
        />
      </div>

      {expanded && (
        <div className="cpm-sub">
          {MODE_ORDER.map((id) => {
            const ok = available(id);
            return (
              <DropdownMenuItem
                key={id}
                label={label(id)}
                description={id === "auto" ? t("chat.webSearch.autoHint") : (!ok ? reason(id) : undefined)}
                onClick={() => onChange(true, id)}
                isDisabled={!ok}
                endContent={mode === id ? <Check className="cpm-check" weight="bold" /> : undefined}
                className={`cpm-subitem${mode === id ? " sel" : ""}`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
