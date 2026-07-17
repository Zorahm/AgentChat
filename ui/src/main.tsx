import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { captureTokenFromUrl, installApiAuth } from "./utils/apiBase";
import { installLinkInterceptor } from "./utils/openExternal";
import { installZoom } from "./utils/zoom";
import "./i18n";
import "katex/dist/katex.min.css";
import "./styles/global.css";
import "./styles/markdown.css";
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
// Route every external link to the OS browser instead of the app webview.
installLinkInterceptor();
// Ctrl +/-/0, Ctrl+wheel and trackpad pinch zoom the whole app.
installZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
