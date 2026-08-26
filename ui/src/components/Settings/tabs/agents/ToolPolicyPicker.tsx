/** How much of the toolbox this agent gets, plus its memory switch.
 *
 * The two belong together because they constrain each other: `memory_only`
 * without memory would ship an agent with no tools at all, which the backend
 * rejects. Rather than surface that as a save error, turning memory off here
 * moves a `memory_only` agent to `none` — the honest reading of "no memory, no
 * other tools either".
 */

import { useTranslation } from "react-i18next";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Switch } from "@astryxdesign/core/Switch";
import type { ToolPolicy } from "../../../../types/agent";

interface ToolPolicyPickerProps {
  policy: ToolPolicy;
  memoryEnabled: boolean;
  /** Empty means "no restriction" — the whitelist is off, not empty. */
  allowedTools: string[];
  /** Every name this build can wire, served by the backend. */
  availableTools: string[];
  onPolicyChange: (policy: ToolPolicy) => void;
  onMemoryChange: (enabled: boolean) => void;
  onAllowedToolsChange: (tools: string[]) => void;
}

export function ToolPolicyPicker({
  policy,
  memoryEnabled,
  allowedTools,
  availableTools,
  onPolicyChange,
  onMemoryChange,
  onAllowedToolsChange,
}: ToolPolicyPickerProps) {
  const { t } = useTranslation();
  const restricted = allowedTools.length > 0;

  const toggleRestriction = (next: boolean) => {
    // Turning the whitelist on with nothing ticked would ship an agent with no
    // tools at all, which is what `none` already means — so it starts from
    // everything and the user narrows from there.
    onAllowedToolsChange(next ? [...availableTools] : []);
  };

  // Unticking the last tool is read as "stop restricting", not as "no tools at
  // all": an empty list is how the backend spells unrestricted. Turning the
  // whole toolbox off is what `none` is for, and it is one radio away.
  const pickTools = (values: string[]) => onAllowedToolsChange(values);

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

      {policy === "full" && availableTools.length > 0 && (
        <>
          <Switch
            label={t("settings.agents.allowedTools")}
            description={t("settings.agents.allowedToolsHint")}
            value={restricted}
            onChange={() => toggleRestriction(!restricted)}
            labelPosition="start"
            labelSpacing="spread"
          />
          {restricted && (
            <div className="ag-tool-grid">
              <CheckboxList
                label={t("settings.agents.allowedToolsLabel")}
                value={allowedTools}
                onChange={pickTools}
              >
                {availableTools.map((name) => (
                  <CheckboxListItem key={name} value={name} label={name} />
                ))}
              </CheckboxList>
            </div>
          )}
        </>
      )}
    </div>
  );
}
