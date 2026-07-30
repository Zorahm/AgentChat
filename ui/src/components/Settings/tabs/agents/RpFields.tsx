/** The "Roleplay" tab: the story side of an agent.
 *
 * Only the two fields that exist because of roleplay — who the *user* plays,
 * and how the character opens — plus the one-click preset that arranges the
 * switches living on the other tabs. Model and temperature are deliberately
 * NOT here: they apply to any agent, so they sit under Basics.
 */

import { useTranslation } from "react-i18next";
import { Check, Info, MaskHappy } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";

interface RpFieldsProps {
  userPersona: string;
  greeting: string;
  /** False once the agent already has the preset's shape. The preset flips
   * switches that live on the *Basics* and *Prompt* tabs, so pressing it here
   * would otherwise look like nothing happened — hence the status line that
   * replaces the button rather than the button simply vanishing. */
  showPreset: boolean;
  onApplyPreset: () => void;
  onUserPersonaChange: (value: string) => void;
  onGreetingChange: (value: string) => void;
}

export function RpFields({
  userPersona,
  greeting,
  showPreset,
  onApplyPreset,
  onUserPersonaChange,
  onGreetingChange,
}: RpFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      {showPreset ? (
        <div className="ag-preset">
          <Button
            label={t("settings.agents.rpPreset")}
            icon={<MaskHappy size={13} />}
            onClick={onApplyPreset}
            variant="secondary"
            size="sm"
          />
          <span className="ag-hint">{t("settings.agents.rpPresetHint")}</span>
        </div>
      ) : (
        <div className="ag-preset ag-preset--done">
          <Check size={14} weight="bold" />
          <span className="ag-hint">{t("settings.agents.rpPresetDone")}</span>
        </div>
      )}

      <TextArea
        label={t("settings.agents.userPersona")}
        description={t("settings.agents.userPersonaHint")}
        value={userPersona}
        onChange={onUserPersonaChange}
        placeholder={t("settings.agents.userPersonaPlaceholder")}
        rows={3}
      />

      <TextArea
        label={t("settings.agents.greeting")}
        description={t("settings.agents.greetingHint")}
        value={greeting}
        onChange={onGreetingChange}
        placeholder={t("settings.agents.greetingPlaceholder")}
        rows={3}
      />

      {/* Sits on this tab because roleplay is where refusals surface first, and
          where users otherwise go hunting Settings for a filter switch that
          does not exist. Stated as a fact about where the boundary lives, not
          as advice on getting around one. */}
      <div className="ag-warning ag-warning--soft ag-warning--info">
        <Info size={14} weight="duotone" />
        <span>{t("settings.agents.censorshipNote")}</span>
      </div>
    </>
  );
}
