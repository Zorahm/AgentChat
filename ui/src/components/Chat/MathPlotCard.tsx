/** The plot card — a `math_plot` call's rendered SVG, inline in the chat.
 *
 *  The markup comes from the backend already themed: its colours are the app's
 *  own CSS variables, so the picture follows light/dark with everything else and
 *  needs no re-render on a theme switch. Injected with dangerouslySetInnerHTML
 *  rather than an <img src="data:…"> for exactly that reason — a data URI is an
 *  isolated document where `var(--chart-1)` resolves to nothing.
 *
 *  Export writes what is on screen: the SVG as-is, or a PNG rasterised from it
 *  at 2× for pasting into something that cannot read vectors. */

import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { DownloadSimple, ChartLine, WarningCircle } from "@phosphor-icons/react";
import { IconButton } from "@astryxdesign/core/IconButton";
import type { ToolCall } from "../../types/tool-call";
import { useDarkMode } from "../../hooks/useDarkMode";
import { normalizeMathPlot } from "../../utils/mathPlot";
import { inlineChartVars } from "../../utils/widgetTheme";

interface MathPlotCardProps {
  call: ToolCall;
}

// Rasterised at twice the SVG's own viewBox so a PNG pasted into a document
// still looks sharp on a high-DPI screen.
const PNG_SCALE = 2;

export function MathPlotCard({ call }: MathPlotCardProps) {
  const { t } = useTranslation();
  const holder = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const isDark = useDarkMode();

  if (!call.plot) return null;
  const plot = normalizeMathPlot(call.plot);

  if (plot.status === "running") {
    return (
      <div className="mathplot-card mathplot-card--pending">
        <ChartLine size={18} weight="bold" />
        <span>{t("chat.mathPlot.rendering")}</span>
      </div>
    );
  }

  if (plot.status === "failed" || !plot.svg) {
    return (
      <div className="mathplot-card mathplot-card--failed">
        <WarningCircle size={18} weight="bold" />
        <span>{plot.error || t("chat.mathPlot.failed")}</span>
      </div>
    );
  }

  const stem = fileStem(plot.title, plot.exprs);

  const saveSvg = (): void => {
    download(new Blob([plot.svg ?? ""], { type: "image/svg+xml" }), `${stem}.svg`);
  };

  const savePng = async (): Promise<void> => {
    setBusy(true);
    try {
      const node = holder.current?.querySelector("svg");
      const blob = node ? await rasterise(node) : null;
      if (blob) download(blob, `${stem}.png`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mathplot-card">
      <div className="mathplot-head">
        <p className="mathplot-title">{plot.title || plot.exprs.join(", ")}</p>
        <div className="mathplot-actions">
          <IconButton
            icon={<DownloadSimple size={15} />}
            label={t("chat.mathPlot.saveSvg")}
            tooltip={t("chat.mathPlot.saveSvg")}
            onClick={saveSvg}
            variant="ghost"
            size="sm"
          />
          <IconButton
            icon={<DownloadSimple size={15} weight="fill" />}
            label={t("chat.mathPlot.savePng")}
            tooltip={t("chat.mathPlot.savePng")}
            onClick={savePng}
            variant="ghost"
            size="sm"
            isDisabled={busy}
          />
        </div>
      </div>

      {/* The backend builds this markup itself — no model-authored HTML reaches
          it, and it carries no script, so there is nothing here for an injected
          payload to ride in on. */}
      <div
        className="mathplot-figure"
        ref={holder}
        style={inlineChartVars(isDark) as CSSProperties}
        dangerouslySetInnerHTML={{ __html: plot.svg }}
      />

      {plot.warnings.length > 0 && (
        <ul className="mathplot-warnings">
          {plot.warnings.map((warning, index) => (
            <li key={`w-${index}`}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Rasterise the live SVG, colours resolved, onto a canvas.
 *
 *  The CSS variables have to be baked in first: the SVG says
 *  `var(--chart-1, #4f9dde)`, and an <img> loaded from a data URI is its own
 *  document with no such variable defined — so an un-inlined export comes out
 *  in fallback colours, or blank where a fallback was missing. */
async function rasterise(node: SVGElement): Promise<Blob | null> {
  // Read off the SVG itself, not the document root: the palette is scoped to the
  // figure so it cannot leak onto the rest of the app, which means the root has
  // no --chart-* to resolve and every series would export in fallback colours.
  const styles = getComputedStyle(node);
  const source = new XMLSerializer()
    .serializeToString(node)
    .replace(/var\(([^,)]+)(?:,\s*([^)]*))?\)/g, (_match, name: string, fallback?: string) => {
      const resolved = styles.getPropertyValue(String(name).trim()).trim();
      return resolved || (fallback ?? "").trim() || "transparent";
    });

  const viewBox = (node.getAttribute("viewBox") ?? "0 0 760 460").split(/\s+/).map(Number);
  const width = (viewBox[2] || 760) * PNG_SCALE;
  const height = (viewBox[3] || 460) * PNG_SCALE;

  const image = new Image();
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("svg decode failed"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // The page background is painted in: a transparent PNG dropped into a light
    // document is unreadable when the chart was drawn for a dark theme. Taken
    // from the root, since the figure's own --bg is deliberately transparent.
    context.fillStyle =
      getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** A filesystem-safe stem from the title, falling back to the expressions. */
function fileStem(title: string, exprs: string[]): string {
  const source = title || exprs.join("-") || "plot";
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "plot";
}
