/** Download a file from the backend straight into the user's Downloads
 *  folder and hand it to the OS to open (its default app for that file type,
 *  or the system "open with" chooser when there isn't one).
 *
 * Desktop (Tauri): writes the bytes via plugin-fs (BaseDirectory.Download),
 * then reuses the same `open_external` shell command used for external links
 * — `Shell::open()` dispatches to the OS default-app handler for any path,
 * not just URLs.
 *
 * Everywhere else (Android Tauri, plain browser/PWA — no fs/shell capability
 * there): falls back to a blob + <a download>, which the browser saves to its
 * own Downloads folder; the OS then offers to open it from the download
 * notification, same end result without native APIs. */

import { invoke } from "@tauri-apps/api/core";
import { isTauri, isAndroidTauri } from "./tauri";

export async function downloadAndOpen(serveUrl: string, filename: string): Promise<void> {
  const resp = await fetch(serveUrl);
  if (!resp.ok) throw new Error(`Download failed (${resp.status})`);

  if (isTauri() && !isAndroidTauri()) {
    const [{ writeFile, BaseDirectory }, { downloadDir, join }] = await Promise.all([
      import("@tauri-apps/plugin-fs"),
      import("@tauri-apps/api/path"),
    ]);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    await writeFile(filename, bytes, { baseDir: BaseDirectory.Download });
    const fullPath = await join(await downloadDir(), filename);
    await invoke("open_external", { url: fullPath });
    return;
  }

  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
}
