import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

const MIN_HEIGHT = 320; // standard height — cannot shrink below this

export function BottomSheet({ open, onClose, children }: BottomSheetProps) {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
      setDragHeight(null);
    } else if (visible) {
      setClosing(true);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishClose = useCallback(() => {
    setVisible(false);
    setClosing(false);
    setDragHeight(null);
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  const handleTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (closing && e.target === sheetRef.current) finishClose();
    },
    [closing, finishClose],
  );

  /* ── handle drag-to-resize ────────────────────────────────────────── */

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    dragRef.current = {
      startY: e.clientY,
      startH: dragHeight ?? sheet.getBoundingClientRect().height,
    };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [dragHeight]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY; // + = moved up (expand)
    const maxH = Math.round(window.innerHeight * 0.92);
    const newH = Math.max(MIN_HEIGHT, Math.min(maxH, dragRef.current.startH + dy));
    setDragHeight(newH);
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  /* ── keyboard dismiss ────────────────────────────────────────────── */

  useEffect(() => {
    if (!visible) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [visible, onClose]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={`bs-backdrop${closing ? "" : " bs-backdrop--open"}`}
      onClick={handleBackdropClick}
    >
      <div
        ref={sheetRef}
        className={`bs-sheet${closing ? "" : " bs-sheet--open"}${dragging ? " bs-sheet--dragging" : ""}`}
        style={dragHeight != null ? { height: dragHeight, maxHeight: "none" } : undefined}
        onClick={(e) => e.stopPropagation()}
        onTransitionEnd={handleTransitionEnd}
      >
        <div
          className="bs-handle"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        <div className="bs-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
