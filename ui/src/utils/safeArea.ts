/** Publishes `--safe-top` / `--safe-bottom`, the insets every screen pads with.
 *
 *  The stylesheets never read `env(safe-area-inset-*)` directly, because on the
 *  Android APK that value lies. Since targetSdk 35 the activity is drawn
 *  edge-to-edge — the webview starts at y=0 of the display, under the status
 *  bar, and ends under the gesture/navigation bar — but Android's WebView only
 *  feeds `env()` from the *display cutout*. A phone whose status bar sits beside
 *  a cutout too small to matter (or none at all) reports 0 while the page really
 *  is behind the bars, and headers land under the clock.
 *
 *  So we detect the full-bleed case by measurement — the webview viewport is as
 *  tall as the display — and, only then, floor the insets at Android's standard
 *  24dp bar height. `max()` keeps a *working* `env()` (notched phones report the
 *  real, larger inset) winning over the floor.
 */

import { isAndroidTauri } from "./tauri";

/** Android's standard system-bar height in dp; CSS px == dp in the webview. */
const ANDROID_BAR_DP = 24;

const TOP = "--safe-top";
const BOTTOM = "--safe-bottom";

/** True when the webview covers the whole display, i.e. the system bars are
 *  painted over our content rather than beside it. Compared with slack because
 *  screen and viewport heights round independently. */
function isFullBleed(): boolean {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  return window.screen.height - viewport <= 2;
}

function apply(): void {
  const root = document.documentElement;
  if (!isFullBleed()) {
    root.style.removeProperty(TOP);
    root.style.removeProperty(BOTTOM);
    return;
  }
  root.style.setProperty(TOP, `max(env(safe-area-inset-top, 0px), ${ANDROID_BAR_DP}px)`);
  root.style.setProperty(BOTTOM, `max(env(safe-area-inset-bottom, 0px), ${ANDROID_BAR_DP}px)`);
}

/** Call once, before the first render. A no-op outside the Android shell, where
 *  the plain `env()` defaults in global.css are already correct. */
export function installSafeArea(): void {
  if (!isAndroidTauri()) return;
  apply();
  // Rotation changes which edge the cutout is on, so re-measure — but only on
  // rotation. `resize` also fires when the soft keyboard opens, and the shrunken
  // viewport would read as "not full bleed" and drop the padding mid-typing.
  window.addEventListener("orientationchange", () => {
    // The viewport still reports its pre-rotation size on the event itself.
    window.setTimeout(apply, 250);
  });
}
