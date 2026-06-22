/** Tracks the app's active theme (the `data-theme` attribute on <html>). */

import { useEffect, useState } from "react";

/** Returns true when the app is in dark mode, updating on theme toggle. */
export function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark",
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}
