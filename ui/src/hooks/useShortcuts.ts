/** Global keyboard-shortcut dispatcher.
 *
 * Installs a single window keydown listener and fires the matching action's
 * handler. Combos that use a modifier (Ctrl/⌘ or Alt) fire everywhere;
 * plain-key combos are ignored while the user is typing in a field, so we
 * don't hijack normal input.
 */

import { useEffect, useRef } from "react";
import {
  comboHasAlt,
  comboHasMod,
  eventMatches,
  type ShortcutBindings,
  type ShortcutId,
} from "../shortcuts/registry";

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>;

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export function useShortcuts(bindings: ShortcutBindings, handlers: ShortcutHandlers): void {
  // Keep the latest bindings/handlers without re-attaching the listener.
  const ref = useRef({ bindings, handlers });
  ref.current = { bindings, handlers };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const { bindings: binds, handlers: hands } = ref.current;
      const editing = isEditableTarget(e.target);

      for (const id of Object.keys(binds) as ShortcutId[]) {
        const combo = binds[id];
        if (!combo) continue;
        // While typing, only let modifier combos through. Alt counts: the
        // message ring is bound to Alt+↑/↓ precisely so it stays reachable
        // with the caret in the composer, which is where it always is.
        if (editing && !comboHasMod(combo) && !comboHasAlt(combo)) continue;
        if (eventMatches(e, combo)) {
          const handler = hands[id];
          if (handler) {
            e.preventDefault();
            e.stopPropagation();
            handler();
          }
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
