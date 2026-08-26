/** The modes the composer's tab strip offers.
 *
 * Mirrors `backend/agent/modes.py` — the ids have to agree, since the id is
 * what travels in the request and what the backend looks up. The backend owns
 * behaviour (prompt, tool whitelist, temperature); this side owns only how the
 * mode is labelled and drawn, so adding a mode means one entry here and one
 * there, and nothing in between.
 *
 * Labels are i18n keys, not strings: they are resolved at render time so the
 * strip follows the app's language like everything else.
 */

/** The absence of a mode. Empty rather than "normal" so a chat that predates
 *  modes reads as normal with no migration. */
export const NORMAL_MODE = "";

export const MATH_MODE = "math";

export interface ChatMode {
  id: string;
  /** i18n key for the tab label and the chip. */
  labelKey: string;
}

/** Selectable modes, in tab order. The normal mode is rendered from
 *  `chat.modes.normal` and is not listed here — it is the absence of an entry,
 *  not an entry. */
export const CHAT_MODES: readonly ChatMode[] = [
  { id: MATH_MODE, labelKey: "chat.modes.math" },
];

export function findMode(id: string | undefined): ChatMode | undefined {
  if (!id) return undefined;
  return CHAT_MODES.find((m) => m.id === id);
}
