import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";
import "./styles/chat.css";
import "./styles/components.css";
import "./styles/panels.css";
import "./styles/tiptap.css";
import "./styles/settings-v2.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
