/** Detect whether the app is running inside a Tauri shell. */

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window ||
      "isTauri" in window ||
      "__TAURI__" in window)
  );
}
