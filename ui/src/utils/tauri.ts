/** Detect whether the app is running inside a Tauri shell. */

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window ||
      "isTauri" in window ||
      "__TAURI__" in window)
  );
}

/** Detect the Tauri Android build (the APK). The Android System WebView's user
 *  agent always carries "Android"; desktop webviews (WebView2 / WebKitGTK /
 *  WKWebView) never do. Used to gate the mobile-only "connect to backend"
 *  screen, since the APK ships without a local backend on 127.0.0.1. */
export function isAndroidTauri(): boolean {
  return (
    isTauri() &&
    typeof navigator !== "undefined" &&
    /Android/i.test(navigator.userAgent)
  );
}
