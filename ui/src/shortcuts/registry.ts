/** Keyboard-shortcut registry + combo encoding.
 *
 * A combo is a normalized string like "Mod+N" or "Mod+Shift+P": modifier
 * tokens in a fixed order (Mod, Alt, Shift) followed by a single key, joined
 * with "+". "Mod" is the platform command key — ⌘ on macOS, Ctrl elsewhere —
 * so one stored combo renders correctly on every OS.
 */

export type ShortcutId =
  | "new_chat"
  | "focus_input"
  | "toggle_sidebar"
  | "open_settings"
  | "goto_projects"
  | "goto_skills";

export interface ShortcutAction {
  id: ShortcutId;
  /** i18n key under settings.shortcuts.actions for the human label. */
  labelKey: string;
  /** Built-in combo, used until the user rebinds it. */
  defaultCombo: string;
}

/** The actions exposed to the shortcut system, in display order. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: "new_chat", labelKey: "new_chat", defaultCombo: "Mod+N" },
  { id: "focus_input", labelKey: "focus_input", defaultCombo: "Mod+L" },
  { id: "toggle_sidebar", labelKey: "toggle_sidebar", defaultCombo: "Mod+B" },
  { id: "open_settings", labelKey: "open_settings", defaultCombo: "Mod+," },
  { id: "goto_projects", labelKey: "goto_projects", defaultCombo: "Mod+Shift+P" },
  { id: "goto_skills", labelKey: "goto_skills", defaultCombo: "Mod+Shift+K" },
] as const;

export type ShortcutBindings = Record<ShortcutId, string>;

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

/** Defaults merged with the user's saved overrides (saved wins when non-empty). */
export function resolveBindings(saved: Record<string, string> | undefined): ShortcutBindings {
  const out = {} as ShortcutBindings;
  for (const action of SHORTCUT_ACTIONS) {
    const override = saved?.[action.id];
    out[action.id] = override && override.trim() ? override : action.defaultCombo;
  }
  return out;
}

/** Keys that only modify other keys — never a combo on their own. */
const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "OS"]);

/** Normalize a KeyboardEvent's main key into a combo token. */
function keyToken(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key || MODIFIER_KEYS.has(key)) return null;
  if (key === " " || key === "Spacebar") return "Space";
  // Single printable chars → uppercase so "n" and "N" match the same combo.
  if (key.length === 1) return key.toUpperCase();
  return key; // named keys: Enter, Escape, ArrowUp, F1, …
}

/** Build the combo string for an event, or null if it's only a modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const token = keyToken(e);
  if (token === null) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(token);
  return parts.join("+");
}

/** Whether a combo uses the platform command modifier (Ctrl/⌘). */
export function comboHasMod(combo: string): boolean {
  return combo.split("+").includes("Mod");
}

/** Does this event match the given combo? */
export function eventMatches(e: KeyboardEvent, combo: string): boolean {
  const got = comboFromEvent(e);
  return got !== null && got === combo;
}

const KEY_LABELS: Record<string, string> = {
  ",": "Comma",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Render a combo for display, e.g. "Mod+Shift+P" → "⌘ ⇧ P" / "Ctrl Shift P". */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  const mac = isMac();
  return combo
    .split("+")
    .map((part) => {
      if (part === "Mod") return mac ? "⌘" : "Ctrl";
      if (part === "Shift") return mac ? "⇧" : "Shift";
      if (part === "Alt") return mac ? "⌥" : "Alt";
      return KEY_LABELS[part] ?? part;
    })
    .join(mac ? " " : "+");
}
