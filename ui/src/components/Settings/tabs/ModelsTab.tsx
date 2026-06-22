import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { SettingsData, ModelConfig } from "../SettingsPanel";

const MAX_ITER_MIN = 1;
const MAX_ITER_MAX = 500;
const DEBOUNCE_MS = 250;

interface ModelsTabProps {
  settings: SettingsData;
  loading: boolean;
  onUpdate: (p: Record<string, unknown>) => void;
  onRefresh: () => void;
}

export function ModelsTab({ settings, loading, onUpdate, onRefresh }: ModelsTabProps) {
  const { t } = useTranslation();

  const [localTemp, setLocalTemp] = useState(settings.temperature);
  const tempTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setLocalTemp(settings.temperature);
  }, [settings.temperature]);

  const handleTempChange = useCallback((v: number) => {
    setLocalTemp(v);
    if (tempTimer.current) clearTimeout(tempTimer.current);
    tempTimer.current = setTimeout(() => onUpdate({ temperature: v }), DEBOUNCE_MS);
  }, [onUpdate]);

  useEffect(() => () => { if (tempTimer.current) clearTimeout(tempTimer.current); }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, ModelConfig[]>();
    for (const m of settings.models) {
      const slash = m.id.indexOf("/");
      const provider = slash > 0 ? m.id.slice(0, slash) : "other";
      const arr = map.get(provider) ?? [];
      arr.push(m);
      map.set(provider, arr);
    }
    return map;
  }, [settings.models]);

  const temp = localTemp;
  const tempLabel = temp <= 0.3 ? t("settings.models.tempPrecise") : temp <= 1.0 ? t("settings.models.tempBalanced") : t("settings.models.tempCreative");

  return (
    <div className="st2-main">
      <div className="st2-models-head">
        <div>
          <h3 className="st2-h">{t("settings.models.title")}</h3>
          <p className="st2-sub">{t("settings.models.description")}</p>
        </div>
        <button className="st2-btn" onClick={onRefresh} disabled={loading}>
          <ArrowClockwise className={loading ? "spin" : ""} weight="bold" />
          {loading ? t("settings.models.refreshing") : t("settings.models.refresh")}
        </button>
      </div>

      {/* 01 Default model */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>{t("settings.models.defaultModel")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.models.defaultModelHint")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.models.defaultModel")}</p>
              <p className="d">{t("settings.models.defaultModelHint")}</p>
            </div>
            <div className="st2-mctl">
              <select
                className="st2-models-select"
                value={settings.default_model}
                onChange={(e) => onUpdate({ default_model: e.target.value })}
              >
                {settings.models.length === 0 && (
                  <option value="">{t("settings.models.noModels")}</option>
                )}
                {Array.from(grouped.entries()).map(([provider, models]) => (
                  <optgroup key={provider} label={provider}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? m.id}{m.thinking ? " · thinking" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      {/* 02 Research model */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>{t("settings.models.researchModel")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.models.researchModelHint")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.models.researchModel")}</p>
              <p className="d">{t("settings.models.researchModelHint")}</p>
            </div>
            <div className="st2-mctl">
              <select
                className="st2-models-select"
                value={settings.research_model || ""}
                onChange={(e) => onUpdate({ research_model: e.target.value })}
              >
                <option value="">{t("settings.models.researchUseDefault")}</option>
                {Array.from(grouped.entries()).map(([provider, models]) => (
                  <optgroup key={provider} label={provider}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? m.id}{m.thinking ? " · thinking" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      {/* 03 Generation parameters */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">03</span>
          <h2>{t("settings.models.generationParams")}</h2>
        </div>
        <p className="st2-md">
          {t("settings.models.generationParamsHint")}
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.models.temperature")}</p>
              <p className="d">{t("settings.models.temperatureHint")}</p>
            </div>
            <div className="st2-mctl">
              <div className="st2-temp">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={localTemp}
                  onChange={(e) => handleTempChange(Number(e.target.value))}
                  onPointerDown={() => { dragging.current = true; }}
                  onPointerUp={() => { dragging.current = false; }}
                  className="st2-temp-slider"
                />
                <div className="st2-temp-value">
                  <span className="st2-temp-num">{temp.toFixed(2)}</span>
                  <span className="st2-temp-label">{tempLabel}</span>
                </div>
                <div className="st2-temp-scale">
                  <span>{t("settings.models.tempPrecise")}</span>
                  <span>{t("settings.models.tempBalanced")}</span>
                  <span>{t("settings.models.tempCreative")}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">{t("settings.models.maxIterations")}</p>
              <p className="d">
                {t("settings.models.maxIterationsHint", { min: MAX_ITER_MIN, max: MAX_ITER_MAX })}
              </p>
            </div>
            <div className="st2-mctl">
              <div className="st2-iter">
                <input
                  type="number"
                  min={MAX_ITER_MIN}
                  max={MAX_ITER_MAX}
                  className="st2-iter-input"
                  value={settings.max_iterations}
                  onChange={(e) => onUpdate({ max_iterations: Number(e.target.value) })}
                />
                <div className="st2-iter-presets">
                  {[25, 50, 100, 200].map((v) => (
                    <button
                      key={v}
                      className={`st2-iter-preset${settings.max_iterations === v ? " active" : ""}`}
                      onClick={() => onUpdate({ max_iterations: v })}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
