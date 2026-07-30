/** How much of the toolbox this agent gets, plus its memory switch.
 *
 * The two belong together because they constrain each other: `memory_only`
 * without memory would ship an agent with no tools at all, which the backend
 * rejects. Rather than surface that as a save error, turning memory off here
 * moves a `memory_only` agent to `none` — the honest reading of "no memory, no
 * other tools either".
 */

import { useTranslation } from "react-i18next";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Switch } from "@astryxdesign/core/Switch";
import type { ToolPolicy } from "../../../../types/agent";

interface ToolPolicyPickerProps {
  policy: ToolPolicy;
  memoryEnabled: boolean;
  onPolicyChange: (policy: ToolPolicy) => void;
  onMemoryChange: (enabled: boolean) => void;
}

export function ToolPolicyPicker({
  policy,
  memoryEnabled,
  onPolicyChange,
  onMemoryChange,
}: ToolPolicyPickerProps) {
  const { t } = useTranslation();

  const pickPolicy = (next: ToolPolicy) => {
    onPolicyChange(next);
    // Choosing "only memory" implies wanting memory — asking the user to also
    // find the switch below would just produce a 400 on save.
    if (next === "memory_only" && !memoryEnabled) onMemoryChange(true);
  };

  const toggleMemory = (next: boolean) => {
    onMemoryChange(next);
    if (!next && policy === "memory_only") onPolicyChange("none");
  };

  return (
    <div className="ag-field">
      <RadioList
        label={t("settings.agents.toolPolicy")}
        value={policy}
        onChange={(val) => pickPolicy(val as ToolPolicy)}
        size="sm"
      >
        <RadioListItem
          value="full"
          label={t("settings.agents.toolPolicyFull")}
          description={t("settings.agents.toolPolicyFullHint")}
        />
        <RadioListItem
          value="memory_only"
          label={t("settings.agents.toolPolicyMemory")}
          description={t("settings.agents.toolPolicyMemoryHint")}
        />
        <RadioListItem
          value="none"
          label={t("settings.agents.toolPolicyNone")}
          description={t("settings.agents.toolPolicyNoneHint")}
        />
      </RadioList>

      <Switch
        label={t("settings.agents.memoryEnabled")}
        description={t("settings.agents.memoryEnabledHint")}
        value={memoryEnabled}
        onChange={() => toggleMemory(!memoryEnabled)}
        labelPosition="start"
        labelSpacing="spread"
      />
    </div>
  );
}
