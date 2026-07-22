/** TEMPORARY debug harness for visually verifying the Astryx-ified UpdateBanner
 * (Spinner + ProgressBar for downloading/installing). Not part of the app —
 * rendered only behind ?debug-update, removed after verification. */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { UpdateBanner } from "./components/Sidebar";
import type { AppUpdate } from "./hooks/useAppUpdate";

function makeUpdate(status: AppUpdate["status"]): AppUpdate {
  return {
    status,
    visible: true,
    busy: status.state === "downloading" || status.state === "installing",
    install: async () => {},
    dismiss: () => {},
  };
}

const cases: { label: string; update: AppUpdate }[] = [
  { label: "available", update: makeUpdate({ state: "available", version: "1.4.0" }) },
  { label: "downloading 0%", update: makeUpdate({ state: "downloading", progress: 0 }) },
  { label: "downloading 42%", update: makeUpdate({ state: "downloading", progress: 42 }) },
  { label: "downloading 100%", update: makeUpdate({ state: "downloading", progress: 100 }) },
  { label: "installing", update: makeUpdate({ state: "installing" }) },
  { label: "error", update: makeUpdate({ state: "error", message: "Network request failed (ECONNRESET)." }) },
];

export function DebugUpdateHarness() {
  return (
    <Theme theme={neutralTheme} mode="dark">
      <div style={{ maxWidth: 280, margin: "40px auto", padding: 16, display: "flex", flexDirection: "column", gap: 24 }}>
        {cases.map(({ label, update }) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: "#9a9a9a", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
              {label}
            </div>
            <div style={{ background: "var(--surface)", borderRadius: 8, padding: "4px 0" }}>
              <UpdateBanner update={update} />
            </div>
          </div>
        ))}
      </div>
    </Theme>
  );
}
