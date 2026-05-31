/** App zoom — Ctrl +/-/0, Ctrl+wheel, and trackpad pinch.
 *
 * The Tauri webview ships with native zoom hotkeys disabled, so we implement
 * zoom in JS. This also means it works identically in a plain browser / PWA
 * (the remote-phone client) without rebuilding the desktop shell. We scale the
 * document with the CSS `zoom` property, which keeps layout intact (unlike
 * transform: scale) and is honoured by the Chromium-based WebView2.
 */

const STORAGE_KEY = "agentchat.zoom";
const MIN = 0.5;
const MAX = 2.0;
const STEP = 0.1;

let level = 1;

function apply(): void {
  document.documentElement.style.setProperty("zoom", String(level));
}

function setLevel(next: number): void {
  level = Math.min(MAX, Math.max(MIN, Math.round(next * 100) / 100));
  apply();
  try {
    localStorage.setItem(STORAGE_KEY, String(level));
  } catch {
    /* private mode — zoom just won't persist */
  }
}

export function installZoom(): void {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (saved >= MIN && saved <= MAX) level = saved;
  apply();

  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      setLevel(level + STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      setLevel(level - STEP);
    } else if (e.key === "0") {
      e.preventDefault();
      setLevel(1);
    }
  });

  // Ctrl+wheel and trackpad pinch both arrive as a wheel event with ctrlKey.
  // passive: false so preventDefault can suppress the browser's own zoom.
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setLevel(level - Math.sign(e.deltaY) * STEP);
    },
    { passive: false },
  );
}
