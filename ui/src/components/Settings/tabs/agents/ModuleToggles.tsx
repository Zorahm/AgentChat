/** Which built-in prompt sections this agent keeps.
 *
 * Only the sections the backend lists as toggleable appear — identity, the
 * shell environment, the tool contract and the sandbox rules are never
 * switchable, because an agent missing those looks configured while quietly
 * misusing the filesystem.
 */

import { useTranslation } from "react-i18next";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";

interface ModuleTogglesProps {
  /** Module names the backend allows switching off. */
  toggleable: string[];
  disabled: string[];
  onChange: (disabled: string[]) => void;
}

export function ModuleToggles({ toggleable, disabled, onChange }: ModuleTogglesProps) {
  const { t } = useTranslation();
  if (toggleable.length === 0) return null;

  // The control speaks in *kept* sections — a checked box meaning "on" reads
  // the right way round; the stored field is the complement.
  const enabled = toggleable.filter((m) => !disabled.includes(m));

  return (
    <div className="ag-modules">
      <CheckboxList
        label={t("settings.agents.modules")}
        description={t("settings.agents.modulesHint")}
        density="compact"
        value={enabled}
        onChange={(next) => onChange(toggleable.filter((m) => !next.includes(m)))}
      >
        {toggleable.map((name) => (
          <CheckboxListItem
            key={name}
            value={name}
            label={t(`settings.agents.module_${name}`, { defaultValue: name })}
          />
        ))}
      </CheckboxList>
    </div>
  );
}
