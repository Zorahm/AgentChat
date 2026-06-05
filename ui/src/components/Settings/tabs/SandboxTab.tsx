/** Settings → Sandbox: unrestricted (no-sandbox) mode toggle. */

import { ShieldWarning } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { SettingsData } from "../SettingsPanel";

export function SandboxTab({ settings, onUpdate }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
}) {
  const { t } = useTranslation();
  const unrestricted = settings.unrestricted_mode ?? false;

  return (
    <div className="st2-main">
      <h3 className="st2-h">{t("settings.general.sandbox")}</h3>
      <p className="st2-sub">{t("settings.general.sandboxDescription")}</p>

      <div className="st2-mrows">
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            <div className={`st2-danger-row${unrestricted ? " on" : ""}`}>
              <div className="lab">
                <p className="t"><ShieldWarning size={16} /> {t("settings.general.unrestricted")}</p>
                <p className="d">
                  {t("settings.general.unrestrictedDescription")}
                </p>
              </div>
              <div className="st2-danger-switch">
                <div className={`st2-switch${unrestricted ? " on" : ""}`}
                  onClick={() => onUpdate({ unrestricted_mode: !unrestricted })} />
              </div>
            </div>
            {unrestricted && (
              <div className="st2-risk-note">
                <b>{t("settings.general.sandboxRemoved")}</b>
                <ul>
                  <li>{t("settings.general.sandboxReadAnyFile")}</li>
                  <li>{t("settings.general.sandboxNoIsolation")}</li>
                  <li>{t("settings.general.sandboxRestartAgent")}</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
