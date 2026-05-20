/** Tauri updater integration — check for updates and install them. */

import { check } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; body?: string; date?: string }
  | { state: "downloading"; progress: number; total?: number }
  | { state: "installing" }
  | { state: "latest" }
  | { state: "error"; message: string };

export async function checkForUpdates(
  onProgress?: (status: UpdateStatus) => void
): Promise<UpdateStatus> {
  try {
    onProgress?.({ state: "checking" });

    const update = await check();

    if (!update) {
      onProgress?.({ state: "latest" });
      return { state: "latest" };
    }

    const status: UpdateStatus = {
      state: "available",
      version: update.version,
      body: update.body ?? undefined,
      date: update.date ?? undefined,
    };
    onProgress?.(status);

    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        onProgress?.({
          state: "downloading",
          progress: 0,
          total: event.data.contentLength,
        });
      } else if (event.event === "Progress") {
        onProgress?.({
          state: "downloading",
          progress: event.data.chunkLength,
        });
      } else if (event.event === "Finished") {
        onProgress?.({ state: "installing" });
      }
    });

    onProgress?.({ state: "installing" });
    return { state: "installing" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ state: "error", message });
    return { state: "error", message };
  }
}

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window ||
      "isTauri" in window ||
      "__TAURI__" in window)
  );
}
