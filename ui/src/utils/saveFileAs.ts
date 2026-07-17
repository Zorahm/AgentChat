/** Save a backend file to a location the user picks, via the OS save dialog.
 *
 * Desktop (Tauri) only: the `save_file_as` Rust command owns both the dialog
 * and the write, so no filesystem scope has to be widened for it. Browser/PWA
 * and Android have no such picker — {@link canSaveAs} reports false there and
 * callers should fall back to `downloadAndOpen`. */

import { invoke } from "@tauri-apps/api/core";
import { isTauri, isAndroidTauri } from "./tauri";

/** Whether a native save dialog exists on this platform. */
export function canSaveAs(): boolean {
  return isTauri() && !isAndroidTauri();
}

/** Prompt for a location and write the file there.
 *  Resolves to the chosen path, or null when the user cancels the dialog. */
export async function saveFileAs(serveUrl: string, filename: string): Promise<string | null> {
  const resp = await fetch(serveUrl);
  if (!resp.ok) throw new Error(`Download failed (${resp.status})`);

  const bytes = Array.from(new Uint8Array(await resp.arrayBuffer()));
  return await invoke<string | null>("save_file_as", { filename, bytes });
}
