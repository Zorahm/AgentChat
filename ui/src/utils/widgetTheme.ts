/**
 * Builds the full HTML document for a `show_widget` visualization iframe.
 *
 * Iframes don't inherit the parent's `:root` CSS variables, so we resolve the
 * app's design tokens here (via getComputedStyle) and bake them into a `<style>`
 * block inside the iframe document — under a stable, documented "widget theme"
 * contract (`--bg`, `--fg`, `--chart-1…8`, …) the model writes against. We also
 * inject a curated categorical chart palette and a tiny resize-reporting script
 * so the host can auto-size the iframe to its content.
 */

/** Read an app token off <html>, falling back when it isn't defined. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Categorical chart palette, tuned per theme for readability on the app's warm
 * light surfaces and dark backgrounds. Not 1:1 with app chrome — this is the
 * dedicated "visualizer" palette.
 */
const CHART_LIGHT = [
  "#3a6bb1", "#4a7a4a", "#b8893a", "#b1554a",
  "#7155b8", "#c8416b", "#2a9d8f", "#6b4f3a",
];
const CHART_DARK = [
  "#7d9fd8", "#7eaf7e", "#d4a050", "#d68070",
  "#b48ce8", "#e88aa8", "#5cc5b5", "#d4b088",
];

/** Resolve every widget-contract variable from the live app theme. */
function widgetVars(isDark: boolean): string {
  const palette = isDark ? CHART_DARK : CHART_LIGHT;
  const bg = token("--surface", isDark ? "#1d1b15" : "#ffffff");
  const bg2 = token("--surface-2", isDark ? "#19170f" : "#faf8f3");
  const fg = token("--ink", isDark ? "#f0ead8" : "#1a1a1a");
  const fg2 = token("--ink-2", isDark ? "#cdc6b1" : "#3d3d3a");
  const muted = token("--muted", isDark ? "#8a8472" : "#767470");
  const faint = token("--faint", isDark ? "#5f5a4d" : "#a8a59f");
  const border = token("--line-2", isDark ? "rgba(245,240,225,.13)" : "rgba(20,20,18,.14)");
  const borderSoft = token("--line", isDark ? "rgba(245,240,225,.07)" : "rgba(20,20,18,.08)");
  const accent = token("--accent", isDark ? "#d4b088" : "#6b4f3a");
  const accent2 = token("--accent-2", isDark ? "#c4a074" : "#8a6d4f");
  const fontSans = token("--font-body", "'Inter', system-ui, -apple-system, sans-serif");
  const fontMono = token("--font-mono", "'JetBrains Mono', ui-monospace, monospace");

  const lines: string[] = [
    `--bg:${bg}`,
    `--bg-2:${bg2}`,
    `--fg:${fg}`,
    `--fg-2:${fg2}`,
    `--muted:${muted}`,
    `--faint:${faint}`,
    `--border:${border}`,
    `--accent:${accent}`,
    `--accent-2:${accent2}`,
    `--grid:${borderSoft}`,
    `--axis:${muted}`,
    `--font-sans:${fontSans}`,
    `--font-mono:${fontMono}`,
    // Claude-style aliases (the model often reaches for these names).
    `--color-text-primary:${fg}`,
    `--color-text-secondary:${muted}`,
    `--color-text-tertiary:${faint}`,
    `--color-border-primary:${border}`,
    `--color-border-secondary:${border}`,
    `--color-border-tertiary:${borderSoft}`,
  ];
  palette.forEach((c, i) => lines.push(`--chart-${i + 1}:${c}`));
  return lines.join(";");
}

/** Script injected into every widget so the host can size the iframe to content. */
function resizeScript(id: string): string {
  return `
<script>
(function(){
  var ID=${JSON.stringify(id)};
  var last=-1;
  function measure(){
    var b=document.body;
    if(!b) return 0;
    // The body's own box height — independent of the iframe viewport, so resizing
    // the iframe to it can never feed back into a larger/smaller measurement.
    return Math.ceil(b.getBoundingClientRect().height)+1;
  }
  function send(){
    var h=measure();
    if(h===last) return;
    last=h;
    try{parent.postMessage({type:"agentchat-widget-height",id:ID,height:h},"*");}catch(e){}
  }
  try{new ResizeObserver(send).observe(document.body);}catch(e){}
  window.addEventListener("load",send);
  [50,300,1000,2500].forEach(function(t){setTimeout(send,t);});
})();
<\/script>`;
}

/** Wrap the model's widget body in a full, themed HTML document. */
export function buildWidgetDocument(bodyHtml: string, isDark: boolean, id: string): string {
  const scheme = isDark ? "dark" : "light";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<style>
:root{color-scheme:${scheme};${widgetVars(isDark)}}
*,*::before,*::after{box-sizing:border-box}
html{overflow-x:auto;overflow-y:hidden}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:var(--font-sans);font-size:14px;line-height:1.5}
body{padding:14px}
img,svg{max-width:100%}
a{color:var(--accent)}
</style>
</head><body>
${bodyHtml}
${resizeScript(id)}
</body></html>`;
}
