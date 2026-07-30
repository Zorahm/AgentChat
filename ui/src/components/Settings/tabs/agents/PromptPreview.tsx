/** The prompt this draft actually produces, assembled by the backend.
 *
 * Replaces the old "load the current default into the textarea" button. That
 * one pasted a snapshot the user then owned forever — it froze the date and
 * the shell dialect, and drifted from the real prompt on the next app update.
 * A preview shows the same thing without copying it anywhere.
 */

import { useTranslation } from "react-i18next";
import { CaretDown, CaretRight, Lightning } from "@phosphor-icons/react";
import type { AgentPreview } from "../../../../types/agent";

interface PromptPreviewProps {
  open: boolean;
  onToggle: () => void;
  preview: AgentPreview | null;
  loading: boolean;
}

export function PromptPreview({ open, onToggle, preview, loading }: PromptPreviewProps) {
  const { t } = useTranslation();

  return (
    <div className="ag-preview">
      <button type="button" className="ag-preview-head" onClick={onToggle}>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span>{t("settings.agents.preview")}</span>
        {preview && (
          <span className="ag-preview-meta">
            {t("settings.agents.previewSize", { count: preview.prompt.length })}
          </span>
        )}
        {preview && !preview.cacheable && (
          <span className="ag-tag ag-tag--warn" title={t("settings.agents.cacheOffHint")}>
            <Lightning size={9} weight="fill" /> {t("settings.agents.cacheOff")}
          </span>
        )}
      </button>

      {open && (
        <div className="ag-preview-body">
          {loading && !preview && <p className="ag-hint">{t("settings.agents.previewLoading")}</p>}
          {preview && (
            <>
              <div className="ag-preview-modules">
                {preview.active_modules.map((m) => (
                  <span key={m} className="ag-modchip">
                    {t(`settings.agents.module_${m}`, { defaultValue: m })}
                  </span>
                ))}
              </div>
              <pre className="ag-preview-text">{preview.prompt}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
