/** The message ring's vocabulary and its one rule, with no React attached.
 *
 * Kept apart from the hook so the wrap-around behaviour — the whole of what
 * the ring does — can be tested without a renderer. See useMessageFocus.ts.
 */

/** Window event the shortcut layer fires; the message list listens for it. */
export const MESSAGE_NAV_EVENT = "message-nav";

export interface MessageNavDetail {
  /** -1 = towards the top of the conversation, 1 = towards the composer. */
  dir: -1 | 1;
}

/** DOM id of a message element, so the ring can scroll it into view. */
export function messageDomId(messageId: string): string {
  return `msg-${messageId}`;
}

/** Where the ring lands next, or null when it should be put away.
 *
 * Entering from nowhere always starts at the LAST message in the branch: it is
 * the one next to the composer, and it is what the user is looking at. Walking
 * off the bottom end puts the ring away again; walking off the top end stops,
 * because silently jumping back to the newest message reads as a lost keypress.
 */
export function nextFocusIndex(
  current: number | null,
  dir: -1 | 1,
  count: number,
): number | null {
  if (count === 0) return null;
  if (current === null) return count - 1;
  const next = current + dir;
  if (next < 0) return 0;
  if (next >= count) return null;
  return next;
}
