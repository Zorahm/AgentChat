/** Image-generation backend picker — one selectable card per backend.
 *
 *  Deliberately shares the web-search picker's `st2-ws-*` classes: it is the
 *  same interaction (a radio list whose selected row expands into its own
 *  config), and a second copy of those styles would drift. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsData } from "../../SettingsPanel";
import { API_BASE } from "../../../../utils/apiBase";

interface BackendStatus {
  id: string;
  available: boolean;
  reason: string;
}

const BACKENDS: { id: string; labelKey: string }[] = [
  { id: "auto", labelKey: "settings.providers.imageGen.backends.auto" },
  { id: "a1111", labelKey: "settings.providers.imageGen.backends.a1111" },
  { id: "comfy", labelKey: "settings.providers.imageGen.backends.comfy" },
  { id: "api", labelKey: "settings.providers.imageGen.backends.api" },
];

interface ImageGenSettingsProps {
  settings: SettingsData;
  onUpdate: (p: Record<string, unknown>) => void;
}

export function ImageGenSettings({ settings, onUpdate }: ImageGenSettingsProps) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<BackendStatus[]>([]);
  const [effective, setEffective] = useState("none");

  const reload = (): void => {
    fetch(`${API_BASE}/config/images`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { backends?: BackendStatus[]; effective?: string } | null) => {
        if (d?.backends) setStatuses(d.backends);
        if (d?.effective) setEffective(d.effective);
      })
      .catch(() => {});
  };
  useEffect(reload, []);

  const backend = settings.image_backend ?? "auto";
  // The picker's own writes land here; a reload lags the PUT by a beat.
  const commit = (patch: Record<string, unknown>): void => {
    onUpdate(patch);
    setTimeout(reload, 300);
  };

  return (
    <div className="st2-ws">
      <div className="st2-pv-section-label">{t("settings.providers.imageGen.title")}</div>
      <p className="st2-sub">{t("settings.providers.imageGen.description")}</p>

      <div
        className="st2-ws-list"
        role="radiogroup"
        aria-label={t("settings.providers.imageGen.title")}
      >
        {BACKENDS.map((b) => {
          const status = statuses.find((s) => s.id === b.id);
          const selected = backend === b.id;
          // "auto" cannot itself be unavailable — it reports what it would pick.
          const hasStatus = b.id !== "auto";
          const available = !hasStatus || !status || status.available;
          const select = (): void => {
            if (!selected) commit({ image_backend: b.id });
          };

          return (
            <div key={b.id} className={`st2-ws-item${selected ? " is-selected" : ""}`}>
              <div
                className="st2-ws-item-head"
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select();
                  }
                }}
              >
                <span className={`st2-ws-radio${selected ? " on" : ""}`} aria-hidden />
                <span className="st2-ws-item-text">
                  <span className="st2-ws-item-title">{t(b.labelKey)}</span>
                  <span className="st2-ws-item-desc">
                    {b.id === "auto"
                      ? t("settings.providers.imageGen.autoDesc", {
                          backend:
                            effective === "none"
                              ? t("settings.providers.imageGen.nothing")
                              : effective,
                        })
                      : t(`settings.providers.imageGen.backendDesc.${b.id}`)}
                  </span>
                </span>
                {hasStatus && (
                  <span
                    className={`st2-ws-status${available ? " ok" : " off"}`}
                    title={status?.reason ?? ""}
                  >
                    {available
                      ? t("settings.providers.webSearch.ready")
                      : t("settings.providers.webSearch.unavailable")}
                  </span>
                )}
              </div>

              {selected && b.id === "a1111" && (
                <div className="st2-ws-config">
                  <UrlField
                    label={t("settings.providers.imageGen.a1111Label")}
                    hint={t("settings.providers.imageGen.a1111Hint")}
                    value={settings.a1111_url ?? ""}
                    placeholder="http://127.0.0.1:7860"
                    onCommit={(v) => commit({ a1111_url: v })}
                  />
                </div>
              )}

              {selected && b.id === "comfy" && (
                <div className="st2-ws-config">
                  <UrlField
                    label={t("settings.providers.imageGen.comfyLabel")}
                    hint={t("settings.providers.imageGen.comfyHint")}
                    value={settings.comfy_url ?? ""}
                    placeholder="http://127.0.0.1:8188"
                    onCommit={(v) => commit({ comfy_url: v })}
                  />
                  <UrlField
                    label={t("settings.providers.imageGen.checkpointLabel")}
                    hint={t("settings.providers.imageGen.checkpointHint")}
                    value={settings.comfy_checkpoint ?? ""}
                    placeholder="sd_xl_base_1.0.safetensors"
                    onCommit={(v) => commit({ comfy_checkpoint: v })}
                  />
                  <UrlField
                    label={t("settings.providers.imageGen.workflowLabel")}
                    hint={t("settings.providers.imageGen.workflowHint")}
                    value={settings.comfy_workflow_path ?? ""}
                    placeholder="C:\\ComfyUI\\workflows\\my-api-workflow.json"
                    onCommit={(v) => commit({ comfy_workflow_path: v })}
                  />
                </div>
              )}

              {selected && b.id === "api" && (
                <div className="st2-ws-config">
                  <UrlField
                    label={t("settings.providers.imageGen.apiModelLabel")}
                    hint={t("settings.providers.imageGen.apiModelHint")}
                    value={settings.image_api_model ?? ""}
                    placeholder="openai/gpt-image-1"
                    onCommit={(v) => commit({ image_api_model: v })}
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

interface UrlFieldProps {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}

/** A labelled text field that saves on blur, mirroring the SearXNG URL row. */
function UrlField({ label, hint, value, placeholder, onCommit }: UrlFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <>
      <label className="st2-ws-config-label">{label}</label>
      <input
        type="text"
        spellCheck={false}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <p className="st2-ws-hint">{hint}</p>
    </>
  );
}
