/** The "Basics" tab: what the agent is, and what it runs on.
 *
 * Identity (name, gradient avatar) plus the two overrides that apply to any
 * agent, roleplay or not — its own model and its own sampling temperature.
 * Split out of AgentCard so the card is a container with tabs rather than one
 * 300-line form.
 */

import { useTranslation } from "react-i18next";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Switch } from "@astryxdesign/core/Switch";
import { AgentAvatar } from "../../../AgentAvatar";

const GRADIENT_SWATCHES: Array<[string, string]> = [
  ["#7c6fdc", "#4f9dde"],
  ["#f2709c", "#ff9472"],
  ["#43e97b", "#38f9d7"],
  ["#fa709a", "#fee140"],
  ["#30cfd0", "#7b2ff7"],
  ["#a18cd1", "#fbc2eb"],
  ["#ff9a9e", "#fecfef"],
  ["#f6d365", "#fda085"],
];

interface AgentBasicsProps {
  name: string;
  fallbackName: string;
  colorFrom: string;
  colorTo: string;
  /** null = follow the global setting. */
  temperature: number | null;
  /** "" = follow the model picked in the chat header. */
  model: string;
  globalTemperature: number;
  availableModels: string[];
  onNameChange: (value: string) => void;
  onColorFromChange: (value: string) => void;
  onColorToChange: (value: string) => void;
  onTemperatureChange: (value: number | null) => void;
  onModelChange: (value: string) => void;
}

export function AgentBasics({
  name,
  fallbackName,
  colorFrom,
  colorTo,
  temperature,
  model,
  globalTemperature,
  availableModels,
  onNameChange,
  onColorFromChange,
  onColorToChange,
  onTemperatureChange,
  onModelChange,
}: AgentBasicsProps) {
  const { t } = useTranslation();
  const overridesTemperature = temperature !== null;

  return (
    <>
      <TextInput label={t("settings.agents.name")} value={name} onChange={onNameChange} />

      <div className="ag-field">
        <span>{t("settings.agents.avatar")}</span>
        <div className="ag-color-row">
          <AgentAvatar name={name || fallbackName} colorFrom={colorFrom} colorTo={colorTo} size={32} />
          <input
            type="color"
            value={colorFrom}
            onChange={(e) => onColorFromChange(e.target.value)}
            title={t("settings.agents.colorFrom")}
          />
          <input
            type="color"
            value={colorTo}
            onChange={(e) => onColorToChange(e.target.value)}
            title={t("settings.agents.colorTo")}
          />
          <div className="ag-swatches">
            {GRADIENT_SWATCHES.map(([from, to]) => (
              <button
                key={`${from}-${to}`}
                className="ag-swatch"
                style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
                onClick={() => { onColorFromChange(from); onColorToChange(to); }}
                title={`${from} → ${to}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="ag-field">
        <label className="ag-select-label" htmlFor="ag-model">
          {t("settings.agents.ownModel")}
        </label>
        <span className="ag-hint">{t("settings.agents.ownModelHint")}</span>
        {availableModels.length > 0 ? (
          <select
            id="ag-model"
            className="ag-select"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">{t("settings.agents.ownModelInherit")}</option>
            {availableModels.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          // No model list (offline, or no provider configured yet) — a free
          // text field beats an empty dropdown that looks broken.
          <TextInput
            label={t("settings.agents.ownModel")}
            isLabelHidden
            value={model}
            onChange={onModelChange}
            placeholder={t("settings.agents.ownModelInherit")}
          />
        )}
      </div>

      <div className="ag-field">
        <Switch
          label={t("settings.agents.ownTemperature")}
          description={t("settings.agents.ownTemperatureHint", { value: globalTemperature })}
          value={overridesTemperature}
          // Seeded from the global value so flipping the switch changes nothing
          // until the slider is moved — an override that silently jumped to a
          // different number would be a trap.
          onChange={() => onTemperatureChange(overridesTemperature ? null : globalTemperature)}
          labelPosition="start"
          labelSpacing="spread"
        />
        {overridesTemperature && (
          <div className="ag-temp-row">
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature}
              onChange={(e) => onTemperatureChange(Number(e.target.value))}
              aria-label={t("settings.agents.ownTemperature")}
            />
            <span className="ag-temp-value">{temperature.toFixed(2)}</span>
          </div>
        )}
      </div>
    </>
  );
}
