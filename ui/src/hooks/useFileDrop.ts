/** Reusable file drag-and-drop for a bounded region (composer, files panel).
 *
 * Returns a `dragging` flag (for a Claude-style overlay) and handlers to spread
 * onto the target element. A depth counter avoids flicker when the cursor moves
 * over child elements, and only real file drags are reacted to — text drags are
 * left alone. stopPropagation keeps a parent / window drop zone from also
 * firing while the cursor is over this region. */

import { useCallback, useRef, useState } from "react";

function dtHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types as ArrayLike<string>).includes("Files");
}

export interface FileDropHandlers {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export interface UseFileDropResult {
  dragging: boolean;
  handlers: FileDropHandlers;
}

export function useFileDrop(onFiles: (files: FileList) => void): UseFileDropResult {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!dtHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current++;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dtHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dtHasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
    },
    [onFiles],
  );

  return { dragging, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
