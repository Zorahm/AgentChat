import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DebugComposerHarness } from "./DebugComposerHarness";
import { DebugImageHarness } from "./DebugImageHarness";
import { DebugMathHarness } from "./DebugMathHarness";
import { DebugOnboardingHarness } from "./DebugOnboardingHarness";
import { DebugResearchHarness } from "./DebugResearchHarness";
import { DebugToolStreamHarness } from "./DebugToolStreamHarness";
import { DebugUpdateHarness } from "./DebugUpdateHarness";
import { DebugUsageHarness } from "./DebugUsageHarness";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { captureTokenFromUrl, installApiAuth } from "./utils/apiBase";
import { installLinkInterceptor } from "./utils/openExternal";
import { installSafeArea } from "./utils/safeArea";
import { syncToShell } from "./utils/serverMode";
import { installZoom } from "./utils/zoom";
import "./i18n";
import "katex/dist/katex.min.css";
import "./styles/katex-math.css";
import "./styles/astryx-setup.css";
import "./styles/global.css";
import "./styles/chat.css";
import "./styles/components.css";
import "./styles/panels.css";
import "./styles/composer.css";
import "./styles/settings.css";
import "./styles/onboarding.css";
import "./styles/projects.css";
import "./styles/usage.css";
import "./styles/responsive.css";

// Pair a phone via ?token=…, then route the Bearer token onto every API call.
// Must run before the first fetch (App effects), i.e. before render.
captureTokenFromUrl();
installApiAuth();
// Keep the Tauri shell's copy of the server-mode flag in step with the
// browser's — the shell reads it before the webview exists, to decide whether
// to spawn a local backend at all.
syncToShell();
// Resolve --safe-top/--safe-bottom before the first paint; the Android APK is
// drawn edge-to-edge and env(safe-area-inset-*) alone under-reports there.
installSafeArea();
// Route every external link to the OS browser instead of the app webview.
installLinkInterceptor();
// Ctrl +/-/0, Ctrl+wheel and trackpad pinch zoom the whole app.
installZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {window.location.search.includes("debug-composer") ? <DebugComposerHarness />
        : window.location.search.includes("debug-update") ? <DebugUpdateHarness />
        : window.location.search.includes("debug-usage") ? <DebugUsageHarness />
        : window.location.search.includes("debug-research") ? <DebugResearchHarness />
        : window.location.search.includes("debug-images") ? <DebugImageHarness />
        : window.location.search.includes("debug-math") ? <DebugMathHarness />
        : window.location.search.includes("debug-toolstream") ? <DebugToolStreamHarness />
        : window.location.search.includes("debug-onboarding") ? <DebugOnboardingHarness />
        : <App />}
    </ErrorBoundary>
  </StrictMode>
);
