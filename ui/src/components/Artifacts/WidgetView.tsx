/** Inline visualization widget — renders model-authored HTML in a themed,
 *  auto-sizing sandboxed iframe (the `show_widget` tool's render surface). */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AppWindow } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Card } from "@astryxdesign/core/Card";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { useDarkMode } from "../../hooks/useDarkMode";
import { buildWidgetDocument } from "../../utils/widgetTheme";

interface WidgetViewProps {
  html: string;
  title?: string;
}

const MIN_HEIGHT = 60;
const DEFAULT_HEIGHT = 320;

export function WidgetView({ html, title }: WidgetViewProps) {
  const { t } = useTranslation();
  const isDark = useDarkMode();
  const id = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  // Rebuild the document when the markup or theme changes — the iframe reloads
  // with freshly-resolved tokens, so light/dark toggles recolor the widget.
  const srcDoc = useMemo(() => buildWidgetDocument(html, isDark, id), [html, isDark, id]);

  // The injected resize script reports the content's *intrinsic* height (measured
  // off the body, so it never feeds back off the iframe's own size). We fit the
  // iframe to that exactly — whatever size the model gave its layout, we keep it.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; id?: string; height?: number } | null;
      if (!data || data.type !== "agentchat-widget-height" || data.id !== id) return;
      // No upper bound — the widget is as tall as its content (like Claude artifacts).
      const next = Math.max(data.height ?? DEFAULT_HEIGHT, MIN_HEIGHT);
      setHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  return (
    <Card className="widget-card" padding={0}>
      <div className="widget-head">
        <AppWindow size={14} weight="bold" />
        <span className="widget-title">{title?.trim() || t("widget.defaultTitle")}</span>
      </div>
      <iframe
        ref={frameRef}
        className="widget-frame"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title={title?.trim() || t("widget.defaultTitle")}
        style={{ height }}
      />
    </Card>
  );
}

/** Shimmering placeholder shown in the widget's slot while the model is still
 *  generating its HTML (the show_widget call is running). Mirrors the card chrome
 *  so it swaps to the live widget in place, without a layout jump. */
export function WidgetSkeleton({ title }: { title?: string }) {
  const { t } = useTranslation();
  return (
    <Card className="widget-card widget-card--loading" padding={0} aria-busy="true" role="status">
      <div className="widget-head">
        <AppWindow size={14} weight="bold" />
        <span className="widget-title">{title?.trim() || t("widget.building")}</span>
      </div>
      <div className="widget-skeleton">
        <Skeleton width="38%" height={14} radius={1} index={0} />
        <Skeleton height={200} radius={2} index={1} />
        <Skeleton width="92%" height={11} radius={1} index={2} />
        <Skeleton width="78%" height={11} radius={1} index={3} />
        <Skeleton width="60%" height={11} radius={1} index={4} />
      </div>
    </Card>
  );
}
