/** Clickable list of the template variables a persona can interpolate. */

import { useTranslation } from "react-i18next";
import { Lightning } from "@phosphor-icons/react";
import type { PromptVariable } from "../../../../types/agent";

interface VariablePaletteProps {
  variables: PromptVariable[];
  /** Names currently present in the persona — those chips read as active. */
  used: string[];
  /** Shown only in replace mode, where pulling the base back in is meaningful. */
  showStructural: boolean;
  onInsert: (name: string) => void;
}

export function VariablePalette({
  variables,
  used,
  showStructural,
  onInsert,
}: VariablePaletteProps) {
  const { t } = useTranslation();
  const structural = showStructural ? ["base", "block:sandbox"] : [];

  return (
    <div className="ag-palette">
      <span className="ag-palette-label">{t("settings.agents.variables")}</span>
      <div className="ag-chips">
        {variables.map((v) => (
          <button
            key={v.name}
            type="button"
            className={`ag-chip${used.includes(v.name) ? " ag-chip--used" : ""}${
              v.volatile ? " ag-chip--volatile" : ""
            }`}
            onClick={() => onInsert(v.name)}
            title={t(`settings.agents.var_${v.name}`, { defaultValue: v.name })}
          >
            {v.volatile && <Lightning size={10} weight="fill" />}
            {`{${v.name}}`}
          </button>
        ))}
        {structural.map((name) => (
          <button
            key={name}
            type="button"
            className={`ag-chip ag-chip--structural${used.includes(name) ? " ag-chip--used" : ""}`}
            onClick={() => onInsert(name)}
            title={t(`settings.agents.var_${name === "base" ? "base" : "block"}`)}
          >
            {`{${name}}`}
          </button>
        ))}
      </div>
      <p className="ag-hint">{t("settings.agents.variablesHint")}</p>
    </div>
  );
}
