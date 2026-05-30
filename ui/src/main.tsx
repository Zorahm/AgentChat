import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { captureTokenFromUrl, installApiAuth } from "./utils/apiBase";
import "./i18n";
import "katex/dist/katex.min.css";
import "./styles/global.css";
import "./styles/markdown.css";
import "./styles/chat.css";
import "./styles/components.css";
import "./styles/panels.css";
import "./styles/tiptap.css";
import "./styles/settings-v2.css";
import "./styles/onboarding.css";
import "./styles/projects.css";
import "./styles/responsive.css";

// Pair a phone via ?token=…, then route the Bearer token onto every API call.
// Must run before the first fetch (App effects), i.e. before render.
captureTokenFromUrl();
installApiAuth();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
