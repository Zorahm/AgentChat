/** Settings → Shortcuts: view and rebind keyboard shortcuts. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ArrowCounterClockwise } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useSettings } from "../../../contexts/SettingsContext";
import {
  SHORTCUT_ACTIONS,
  resolveBindings,
  comboFromEvent,
  formatCombo,
  type ShortcutId,
} from "../../../shortcuts/registry";

interface Conflict {
  forId: ShortcutId;
  withId: ShortcutId;
}

export function ShortcutsTab() {
  const { t } = useTranslation();
  const { shortcuts, updateSettings } = useSettings();
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const bindings = useMemo(() => resolveBindings(shortcuts), [shortcuts]);

  const label = useCallback(
    (id: ShortcutId) => t(`settings.shortcuts.actions.${id}`),
    [t],
  );

  const save = useCallback(
    (next: Record<string, string>) => {
      void updateSettings({ shortcuts: next });
    },
    [updateSettings],
  );

  const setCombo = useCallback(
    (id: ShortcutId, combo: string) => save({ ...bindings, [id]: combo }),
    [bindings, save],
  );

  // While recording, capture the next key combo before the global dispatcher
  // sees it (capture phase + stopPropagation), so binding e.g. Mod+B doesn't
  // also collapse the sidebar.
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        setConflict(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // a lone modifier — keep waiting
      const clash = SHORTCUT_ACTIONS.find(
        (a) => a.id !== recordingId && bindings[a.id] === combo,
      );
      if (clash) {
        setConflict({ forId: recordingId, withId: clash.id });
        return; // stay in recording mode so the user can pick another
      }
      setCombo(recordingId, combo);
      setRecordingId(null);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, bindings, setCombo]);

  return (
    <div className="st2-sc">
      <h3 className="st2-h">{t("settings.shortcuts.title")}</h3>
      <p className="st2-sub">{t("settings.shortcuts.description")}</p>

      <div className="st2-sc-list">
        {SHORTCUT_ACTIONS.map((action) => {
          const recording = recordingId === action.id;
          const showConflict = conflict?.forId === action.id;
          return (
            <div className="st2-sc-row" key={action.id}>
              <span className="st2-sc-label">{label(action.id)}</span>
              <div className="st2-sc-controls">
                {showConflict && (
                  <span className="st2-sc-conflict">
                    {t("settings.shortcuts.conflict", { action: label(conflict.withId) })}
                  </span>
                )}
                <Button
                  label={recording ? t("settings.shortcuts.recording") : formatCombo(bindings[action.id] ?? action.defaultCombo)}
                  onClick={() => {
                    setConflict(null);
                    setRecordingId(recording ? null : action.id);
                  }}
                  tooltip={t("settings.shortcuts.rebindTooltip")}
                  variant={recording ? "primary" : "secondary"}
                  className="st2-sc-combo"
                />
                <IconButton
                  label={t("settings.shortcuts.reset")}
                  icon={<ArrowCounterClockwise size={14} />}
                  isDisabled={bindings[action.id] === action.defaultCombo}
                  onClick={() => {
                    setConflict(null);
                    setRecordingId(null);
                    setCombo(action.id, action.defaultCombo);
                  }}
                  variant="ghost"
                  size="sm"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="st2-sc-foot">
        <span className="st2-sc-hint">
          <Keyboard size={14} /> {t("settings.shortcuts.hint")}
        </span>
        <Button
          label={t("settings.shortcuts.resetAll")}
          onClick={() => { setRecordingId(null); setConflict(null); save({}); }}
          variant="secondary"
        />
      </div>
    </div>
  );
}
