/** Full-screen file drag overlay — shown only where dropping files makes
 * sense (the chat / welcome screen). Elsewhere (settings, projects, all-chats,
 * files gallery) the overlay stays off; project/chat composers handle their
 * own drops directly on the editor. */

import { useState, useEffect, useRef } from "react";
import { CloudArrowUp } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

interface GlobalDropZoneProps {
  /** Show the overlay and broadcast drops. False = inert (settings/projects). */
  enabled: boolean;
}

// `dataTransfer.types` is an array in modern browsers but a DOMStringList in
// others — normalise so `.includes()` never throws. A throw here would skip the
// `preventDefault` below, and without it the browser hijacks the drop (opens /
// navigates to the file) and drag-and-drop appears completely dead.
function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types as ArrayLike<string>).includes("Files");
}

export function GlobalDropZone({ enabled }: GlobalDropZoneProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const counter = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always stop the webview from navigating to a dropped file — even where the
  // overlay is disabled. Composers that want the drop call stopPropagation, so
  // this only catches strays that would otherwise open the file in the window.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Overlay + drop broadcast — only while enabled (chat / welcome).
  useEffect(() => {
    if (!enabled) {
      counter.current = 0;
      setActive(false);
      return;
    }

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
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      clear();
      counter.current++;
      setActive(true);
    };

    const onDragLeave = () => {
      counter.current = Math.max(0, counter.current - 1);
      if (counter.current === 0) scheduleHide();
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault(); // REQUIRED — otherwise the drop event never fires
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
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
    // phase onDrop above from ever firing and the overlay would stay open after
    // the file is attached. Running in capture phase means we close the overlay
    // before any target handler can swallow the event.
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
      clear();
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("drop", closeOverlay, true);
      window.removeEventListener("dragend", closeOverlay, true);
    };
  }, [enabled]);

  if (!active) return null;

  return (
    <div className="gdz">
      <div className="gdz-card">
        <CloudArrowUp size={36} weight="light" />
        <span>{t("chat.dropZone")}</span>
      </div>
    </div>
  );
}
