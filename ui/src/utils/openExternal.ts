/** Open external links in the user's real browser, never the app webview.
 *
 * Inside Tauri, a bare <a href> navigates the webview itself, stranding the
 * user with only a right-click "Back" to escape. We intercept every external
 * link click app-wide and route it to the OS browser instead. In a plain
 * browser / PWA build this falls back to a normal new tab.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

/** Open a single URL in the real browser. */
export function openExternal(url: string): void {
  if (isTauri()) {
    void invoke("open_external", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Install a one-time, document-wide click interceptor for external links. */
export function installLinkInterceptor(): void {
  document.addEventListener(
    "click",
    (e) => {
      // Respect modified clicks and anything already handled.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement | null)?.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href) return;

      // In-page anchors (footnotes #fn-…) keep their native scroll behavior.
      if (href.startsWith("#")) return;
      // Only real external schemes get redirected to the browser.
      if (!/^(https?:|mailto:)/i.test(href)) return;

      e.preventDefault();
      openExternal(href);
    },
    true,
  );
}
