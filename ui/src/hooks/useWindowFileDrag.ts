/** True while a file is being dragged anywhere over the window.
 *
 * Used to light up *all* drop targets at once the moment a file enters the
 * window (Claude-style), rather than only when the cursor is over a specific
 * zone. Anti-navigation preventDefault is handled elsewhere (GlobalDropZone),
 * so this hook only tracks state. */

import { useEffect, useRef, useState } from "react";

function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types as ArrayLike<string>).includes("Files");
}

export function useWindowFileDrag(): boolean {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      depth.current++;
      setActive(true);
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const reset = () => {
      depth.current = 0;
      setActive(false);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset, true);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset, true);
    };
  }, []);

  return active;
}
