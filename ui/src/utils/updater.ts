/** Tauri updater integration — check for updates and install them.
 *
 * Split into two steps: `checkForUpdate` only queries the release endpoint and
 * reports whether something newer exists; `installUpdate` downloads + installs
 * the update found by the last check. This lets the UI show the version / notes
 * in a card before the user commits to installing.
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; body?: string; date?: string }
  | { state: "downloading"; progress: number; total?: number }
  | { state: "installing" }
  | { state: "latest" }
  | { state: "error"; message: string };

/** The Update handle from the most recent successful check, awaiting install. */
let pending: Update | null = null;

/** Query the release endpoint. Does NOT download or install. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const update = await check();
    if (!update) {
      pending = null;
      return { state: "latest" };
    }
    pending = update;
    return {
      state: "available",
      version: update.version,
      body: update.body ?? undefined,
      date: update.date ?? undefined,
    };
  } catch (err) {
    pending = null;
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Download + install the update found by the last `checkForUpdate`. */
export async function installUpdate(
  onProgress?: (status: UpdateStatus) => void
): Promise<UpdateStatus> {
  if (!pending) {
    return { state: "error", message: "Нет обновления для установки. Сначала проверьте." };
  }
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") {
        onProgress?.({ state: "downloading", progress: 0, total: event.data.contentLength });
      } else if (event.event === "Progress") {
        onProgress?.({ state: "downloading", progress: event.data.chunkLength });
      } else if (event.event === "Finished") {
        onProgress?.({ state: "installing" });
      }
    });
    onProgress?.({ state: "installing" });
    // Restart so the freshly installed version takes effect immediately.
    await relaunch();
    return { state: "installing" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ state: "error", message });
    return { state: "error", message };
  }
}
