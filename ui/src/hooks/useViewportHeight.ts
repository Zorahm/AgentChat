import { useEffect } from "react";

/**
 * Pins a `--app-height` CSS variable to the *visible* viewport height.
 *
 * Mobile browsers' `100dvh`/`100vh` can resolve taller than the on-screen area
 * (collapsing URL bar, Chrome devtools device mode that only recomputes viewport
 * units on resize), which clips bottom-pinned UI like the chat composer — you
 * "only see its edge" until you resize. `visualViewport.height` (fallback
 * `window.innerHeight`) is always the real visible height and updates on URL-bar
 * show/hide and keyboard open/close, so the shell follows the keyboard too.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = (): void => {
      const h = Math.round(vv?.height ?? window.innerHeight);
      document.documentElement.style.setProperty("--app-height", `${h}px`);
    };
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
    };
  }, []);
}
