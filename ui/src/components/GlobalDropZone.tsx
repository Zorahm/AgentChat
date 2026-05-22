/** Full-screen file drag overlay — shows on any file drag into the window. */

import { useState, useEffect, useRef } from "react";
import { CloudArrowUp } from "@phosphor-icons/react";

export function GlobalDropZone() {
  const [active, setActive] = useState(false);
  const counter = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    };
    const scheduleHide = () => {
      clear();
      hideTimer.current = setTimeout(() => {
        if (counter.current <= 0) { counter.current = 0; setActive(false); }
      }, 60);
    };

    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      clear();
      counter.current++;
      setActive(true);
    };

    const onDragLeave = () => {
      counter.current = Math.max(0, counter.current - 1);
      if (counter.current === 0) scheduleHide();
    };

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      counter.current = 0;
      clear();
      setActive(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        window.dispatchEvent(new CustomEvent("global-files-drop", { detail: files }));
      }
    };

    // Capture-phase closer: ChatInput's drop handler calls stopPropagation to
    // keep its own logic isolated, which would otherwise prevent the bubble-
    // phase onDrop below from ever firing and the overlay would stay open
    // after the file is attached. Running in capture phase means we close the
    // overlay before any target handler can swallow the event.
    const closeOverlay = () => {
      counter.current = 0;
      clear();
      setActive(false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("drop", closeOverlay, true);
    window.addEventListener("dragend", closeOverlay, true);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("drop", closeOverlay, true);
      window.removeEventListener("dragend", closeOverlay, true);
    };
  }, []);

  if (!active) return null;

  return (
    <div className="gdz">
      <div className="gdz-card">
        <CloudArrowUp size={36} weight="light" />
        <span>Перетащите файлы</span>
      </div>
    </div>
  );
}
