/** The prompt half of an agent: mode, template, variables, module toggles.
 *
 * The persona is a template rather than captured text — see
 * backend/agent/prompt/variables.py. Everything here is controlled by
 * AgentCard, which owns the draft and the save.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WarningCircle } from "@phosphor-icons/react";
import { TextArea } from "@astryxdesign/core/TextArea";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { AgentEditorMeta, AgentPreview, PromptMode } from "../../../../types/agent";
import type { AgentDraft } from "../../../../hooks/useAgents";
import { ModuleToggles } from "./ModuleToggles";
import { PromptPreview } from "./PromptPreview";
import { VariablePalette } from "./VariablePalette";
import { insertVariable, readTemplate } from "./template";

const PREVIEW_DEBOUNCE_MS = 400;

interface PersonaEditorProps {
  draft: AgentDraft;
  meta: AgentEditorMeta;
  onPersonaChange: (text: string) => void;
  onModeChange: (mode: PromptMode) => void;
  onModulesChange: (disabled: string[]) => void;
  fetchPreview: (draft: AgentDraft) => Promise<AgentPreview | null>;
}

export function PersonaEditor({
  draft,
  meta,
  onPersonaChange,
  onModeChange,
  onModulesChange,
  fetchPreview,
}: PersonaEditorProps) {
  const { t } = useTranslation();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const reading = readTemplate(draft.system_prompt, meta.variables);
  const replaceMode = draft.prompt_mode === "replace";
  // A replace-mode persona owns the whole prompt, so nothing supplies the date
  // unless it asks for it — worth saying out loud before the model insists it
  // doesn't know what day it is.
  const missingDate = replaceMode && draft.system_prompt.trim() !== "" && !reading.used.includes("date");

  useEffect(() => {
    if (!previewOpen) return;
    let cancelled = false;
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      void fetchPreview(draft).then((result) => {
        if (cancelled) return;
        setPreview(result);
        setPreviewLoading(false);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Re-assembles whenever any input to the prompt changes.
  }, [previewOpen, draft, fetchPreview]);

  // Restore the caret after an insert — React re-renders with the new value and
  // would otherwise drop the cursor at the end of the textarea.
  useEffect(() => {
    const caret = caretRef.current;
    if (caret === null || !areaRef.current) return;
    caretRef.current = null;
    areaRef.current.focus();
    areaRef.current.setSelectionRange(caret, caret);
  }, [draft.system_prompt]);

  const onInsert = (name: string) => {
    const area = areaRef.current;
    const start = area?.selectionStart ?? draft.system_prompt.length;
    const end = area?.selectionEnd ?? start;
    const next = insertVariable(draft.system_prompt, name, start, end);
    caretRef.current = next.caret;
    onPersonaChange(next.text);
  };

  return (
    <div className="ag-persona">
      <div className="ag-field">
        <span>{t("settings.agents.mode")}</span>
        <SegmentedControl
          label={t("settings.agents.mode")}
          size="sm"
          value={draft.prompt_mode}
          onChange={(v) => onModeChange(v as PromptMode)}
        >
          <SegmentedControlItem value="append" label={t("settings.agents.modeAppend")} />
          <SegmentedControlItem value="replace" label={t("settings.agents.modeReplace")} />
        </SegmentedControl>
        <p className="ag-hint">
          {replaceMode ? t("settings.agents.modeReplaceHint") : t("settings.agents.modeAppendHint")}
        </p>
      </div>

      <TextArea
        ref={areaRef}
        label={t("settings.agents.persona")}
        value={draft.system_prompt}
        onChange={onPersonaChange}
        placeholder={
          replaceMode
            ? t("settings.agents.personaPlaceholderReplace")
            : t("settings.agents.personaPlaceholderAppend")
        }
        rows={8}
      />

      <VariablePalette
        variables={meta.variables}
        used={reading.used}
        showStructural={replaceMode}
        onInsert={onInsert}
      />

      {reading.unknown.length > 0 && (
        <div className="ag-warning ag-warning--soft">
          <WarningCircle size={15} weight="fill" />
          <span>
            {t("settings.agents.unknownVars", {
              names: reading.unknown.map((n) => `{${n}}`).join(", "),
              count: reading.unknown.length,
            })}
          </span>
        </div>
      )}

      {missingDate && (
        <div className="ag-warning ag-warning--soft">
          <WarningCircle size={15} weight="fill" />
          <span>{t("settings.agents.missingDateHint")}</span>
        </div>
      )}

      {reading.volatile.length > 0 && (
        <p className="ag-hint">
          {t("settings.agents.cacheOffHintInline", {
            names: reading.volatile.map((n) => `{${n}}`).join(", "),
          })}
        </p>
      )}

      <ModuleToggles
        toggleable={meta.toggleable_modules}
        disabled={draft.disabled_modules}
        onChange={onModulesChange}
      />

      <PromptPreview
        open={previewOpen}
        onToggle={() => setPreviewOpen((v) => !v)}
        preview={preview}
        loading={previewLoading}
      />
    </div>
  );
}
