/** Web-search backend picker — one selectable card per mode, config inline. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import type { SettingsData } from "../../SettingsPanel";
import { API_BASE } from "../../../../utils/apiBase";
import { SearxngInstaller } from "./SearxngInstaller";

interface WsModeStatus { id: string; available: boolean; reason: string }

const MODES: { id: string; labelKey: string }[] = [
  { id: "auto", labelKey: "chat.webSearch.modes.auto" },
  { id: "native", labelKey: "chat.webSearch.modes.native" },
  { id: "litellm", labelKey: "chat.webSearch.modes.litellm" },
  { id: "searxng", labelKey: "chat.webSearch.modes.searxng" },
];

interface WebSearchSettingsProps {
  settings: SettingsData;
  onUpdate: (p: Record<string, unknown>) => void;
}

export function WebSearchSettings({ settings, onUpdate }: WebSearchSettingsProps) {
  const { t } = useTranslation();
  const [modes, setModes] = useState<WsModeStatus[]>([]);
  const [searxng, setSearxng] = useState(settings.searxng_url ?? "");
  const [tavily, setTavily] = useState("");

  useEffect(() => { setSearxng(settings.searxng_url ?? ""); }, [settings.searxng_url]);

  const reloadModes = () => {
    fetch(`${API_BASE}/config/web-search`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { modes?: WsModeStatus[] } | null) => { if (d?.modes) setModes(d.modes); })
      .catch(() => {});
  };
  useEffect(reloadModes, []);

  const mode = settings.web_search_mode ?? "auto";

  const commitSearxng = () => {
    const next = searxng.trim();
    if (next !== (settings.searxng_url ?? "")) onUpdate({ searxng_url: next });
    setTimeout(reloadModes, 300);
  };

  const commitTavily = () => {
    if (!tavily.trim()) return;
    onUpdate({ tavily_api_key: tavily.trim() });
    setTavily("");
    setTimeout(reloadModes, 300);
  };

  return (
    <div className="st2-ws">
      <div className="st2-pv-section-label">{t("settings.providers.webSearch.title")}</div>
      <p className="st2-sub">{t("settings.providers.webSearch.description")}</p>

      <div className="st2-ws-list" role="radiogroup" aria-label={t("settings.providers.webSearch.title")}>
        {MODES.map((m) => {
          const st = modes.find((x) => x.id === m.id);
          const selected = mode === m.id;
          // "auto" has nothing to be unavailable about — it picks whatever works.
          const hasStatus = m.id !== "auto";
          const available = !hasStatus || !st || st.available;
          const select = () => { if (!selected) onUpdate({ web_search_mode: m.id }); };

          return (
            <div key={m.id} className={`st2-ws-item${selected ? " is-selected" : ""}`}>
              <div
                className="st2-ws-item-head"
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
                }}
              >
                <span className={`st2-ws-radio${selected ? " on" : ""}`} aria-hidden />
                <span className="st2-ws-item-text">
                  <span className="st2-ws-item-title">{t(m.labelKey)}</span>
                  <span className="st2-ws-item-desc">
                    {t(`settings.providers.webSearch.modeDesc.${m.id}`)}
                  </span>
                </span>
                {hasStatus && (
                  <span
                    className={`st2-ws-status${available ? " ok" : " off"}`}
                    title={st?.reason ?? ""}
                  >
                    {available
                      ? t("settings.providers.webSearch.ready")
                      : t("settings.providers.webSearch.unavailable")}
                  </span>
                )}
              </div>

              {selected && m.id === "litellm" && (
                <div className="st2-ws-config">
                  <label className="st2-ws-config-label">
                    {t("settings.providers.webSearch.tavilyLabel")}
                    {settings.tavily_api_key_set && (
                      <span className="st2-ws-ok">✓ {t("settings.providers.webSearch.configured")}</span>
                    )}
                  </label>
                  <div className="st2-ws-keyrow">
                    <input
                      type="password"
                      autoComplete="off"
                      value={tavily}
                      placeholder={settings.tavily_api_key_set ? "••••••••••••" : "tvly-..."}
                      onChange={(e) => setTavily(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") commitTavily(); }}
                    />
                    <Button
                      label={t("common.save")}
                      onClick={commitTavily}
                      isDisabled={!tavily.trim()}
                      variant={tavily.trim() ? "primary" : "secondary"}
                      size="sm"
                    />
                  </div>
                  <p className="st2-ws-hint">{t("settings.providers.webSearch.tavilyHint")}</p>
                </div>
              )}

              {selected && m.id === "searxng" && (
                <div className="st2-ws-config">
                  <label className="st2-ws-config-label">
                    {t("settings.providers.webSearch.searxngLabel")}
                  </label>
                  <input
                    type="text"
                    spellCheck={false}
                    value={searxng}
                    placeholder="http://localhost:8080"
                    onChange={(e) => setSearxng(e.target.value)}
                    onBlur={commitSearxng}
                  />
                  <p className="st2-ws-hint">{t("settings.providers.webSearch.searxngHint")}</p>
                  <SearxngInstaller
                    onInstalled={(url) => { onUpdate({ searxng_url: url }); setTimeout(reloadModes, 400); }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
