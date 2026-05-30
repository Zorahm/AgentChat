/** Web search toggle + mode picker for the chat composer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, CaretDown, Check } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { API_BASE } from "../../utils/apiBase";

interface ModeStatus {
  id: "auto" | "native" | "litellm" | "searxng";
  available: boolean;
  reason: string;
}

interface WebSearchControlProps {
  enabled: boolean;
  mode: string;
  onChange: (enabled: boolean, mode?: string) => void;
}

const MODE_ORDER: ModeStatus["id"][] = ["auto", "native", "litellm", "searxng"];

export function WebSearchControl({ enabled, mode, onChange }: WebSearchControlProps) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<ModeStatus[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const modeLabel = useCallback(
    (id: string) => t(`chat.webSearch.modes.${id}`, { defaultValue: id }),
    [t],
  );

  const available = (id: ModeStatus["id"]): boolean => {
    if (id === "auto") return true;
    return statuses.find((s) => s.id === id)?.available ?? false;
  };

  const reason = (id: ModeStatus["id"]): string =>
    statuses.find((s) => s.id === id)?.reason ?? "";

  return (
    <div className="ws-control" ref={rootRef}>
      <button
        className={`ws-toggle${enabled ? " on" : ""}`}
        onClick={() => onChange(!enabled, mode)}
        title={t("chat.webSearch.toggle")}
      >
        <Globe size={16} />
      </button>
      {enabled && (
        <button className="ws-mode" onClick={() => setMenuOpen((v) => !v)} title={t("chat.webSearch.mode")}>
          <span>{modeLabel(mode)}</span>
          <CaretDown size={11} />
        </button>
      )}
      {enabled && menuOpen && (
        <div className="ws-menu">
          {MODE_ORDER.map((id) => {
            const ok = available(id);
            return (
              <button
                key={id}
                className={`ws-menu-item${mode === id ? " active" : ""}`}
                disabled={!ok}
                title={id === "auto" ? t("chat.webSearch.autoHint") : reason(id)}
                onClick={() => { onChange(true, id); setMenuOpen(false); }}
              >
                <span className="ws-menu-check">{mode === id ? <Check size={12} /> : null}</span>
                <span className="ws-menu-label">{modeLabel(id)}</span>
                {id !== "auto" && !ok && <span className="ws-menu-reason">{reason(id)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
