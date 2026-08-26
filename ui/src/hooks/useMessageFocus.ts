/** Keyboard ring that walks the message list.
 *
 * The frame around a message is invisible until it is asked for: Alt+↑/↓
 * (rebindable in Settings → Shortcuts) moves the ring, Escape puts it away.
 * The shortcut layer lives in App, so the binding arrives here as a window
 * event — the same hand-off the composer already uses for `focus-composer`.
 *
 * The ring deliberately does NOT take DOM focus. The caret stays in the
 * composer, so a user who was mid-sentence can walk back through the reply
 * they are answering and keep typing without clicking anything.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MESSAGE_NAV_EVENT,
  messageDomId,
  nextFocusIndex,
  type MessageNavDetail,
} from "../utils/messageRing";

export { MESSAGE_NAV_EVENT, messageDomId };
export type { MessageNavDetail };

/**
 * @param ids  Message ids of the visible branch, oldest first.
 * @param resetKey  Changes when the conversation does (chat id) — the ring
 *   must not survive into another chat, where the index means nothing.
 */
export function useMessageFocus(ids: readonly string[], resetKey: string): string | null {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // The listeners are attached once; reading ids through a ref keeps them from
  // being re-bound on every token of a streaming reply.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  useEffect(() => {
    setFocusedId(null);
  }, [resetKey]);

  // A ring left on a message that got edited away (retry, branch switch) would
  // never clear itself — nothing else in the chat knows it exists.
  useEffect(() => {
    if (focusedId !== null && !ids.includes(focusedId)) setFocusedId(null);
  }, [ids, focusedId]);

  const move = useCallback((dir: -1 | 1) => {
    setFocusedId((current) => {
      const list = idsRef.current;
      const index = current === null ? -1 : list.indexOf(current);
      const next = nextFocusIndex(index === -1 ? null : index, dir, list.length);
      if (next === null) {
        // Off the bottom: hand the keyboard back to the composer rather than
        // leaving the user in a mode with no visible way out.
        window.dispatchEvent(new CustomEvent("focus-composer"));
        return null;
      }
      return list[next] ?? null;
    });
  }, []);

  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<MessageNavDetail>).detail;
      if (detail?.dir === -1 || detail?.dir === 1) move(detail.dir);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only claim Escape while the ring is actually on screen; otherwise it
      // belongs to whatever dialog or inline editor is open.
      setFocusedId((current) => {
        if (current === null) return null;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("focus-composer"));
        return null;
      });
    };
    window.addEventListener(MESSAGE_NAV_EVENT, onNav);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(MESSAGE_NAV_EVENT, onNav);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [move]);

  // Scroll after paint, so the element the ring just moved to exists.
  useEffect(() => {
    if (focusedId === null) return;
    const el = document.getElementById(messageDomId(focusedId));
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedId]);

  return focusedId;
}
