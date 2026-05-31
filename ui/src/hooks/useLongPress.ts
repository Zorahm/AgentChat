/** Universal context-menu trigger.
 *
 * Desktop opens the menu on right-click; touch devices (phone/tablet) open it
 * with a long press, since they have no right mouse button. The press is
 * cancelled if the finger moves (that's a scroll, not a hold), and the tap
 * that the browser synthesises after a long press is swallowed so the item
 * isn't also "clicked".
 */

import { useCallback, useEffect, useRef } from "react";

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

export interface LongPressBinding {
  onContextMenu: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export interface UseLongPressResult {
  bind: LongPressBinding;
  /** Call from the element's onClick: returns true (once) if the click is the
   *  synthetic tap following a long press and should be ignored. */
  shouldSuppressClick: () => boolean;
}

export function useLongPress(onOpen: (x: number, y: number) => void): UseLongPressResult {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const suppress = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onOpen(e.clientX, e.clientY);
    },
    [onOpen],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      origin.current = { x: touch.clientX, y: touch.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        suppress.current = true;
        const o = origin.current;
        if (o) onOpen(o.x, o.y);
      }, LONG_PRESS_MS);
    },
    [onOpen, cancel],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const o = origin.current;
      if (!touch || !o) return;
      if (
        Math.abs(touch.clientX - o.x) > MOVE_TOLERANCE_PX ||
        Math.abs(touch.clientY - o.y) > MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const shouldSuppressClick = useCallback(() => {
    if (suppress.current) {
      suppress.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    bind: { onContextMenu, onTouchStart, onTouchMove, onTouchEnd: cancel, onTouchCancel: cancel },
    shouldSuppressClick,
  };
}
