/** Debug harness for the environment setup screen (?debug-onboarding or ?debug-setup).
 *
 * Provides a mock backend with interactive scenario controls:
 * - Normal WSL flow (auto-install success)
 * - Windows PowerShell winget flow
 * - Error flow (UAC declined / failure) to test retry and continue buttons
 * - Slow install with live streaming log
 *
 * IMPORTANT: this module must stay free of import-time side effects. `main.tsx`
 * imports every harness statically, so anything that runs at module scope runs
 * in the real app too.
 */

import { useEffect, useRef, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { EnvironmentSetup } from "./components/Onboarding/EnvironmentSetup";

type MockScenario = "wsl-success" | "win-success" | "install-error" | "streaming-log";

interface HarnessState {
  scenario: MockScenario;
  pollStep: number;
  userName: string;
}

const harnessState: HarnessState = {
  scenario: "wsl-success",
  pollStep: 0,
  userName: "",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body: Record<string, unknown> =
    typeof init?.body === "string" ? JSON.parse(init.body) : {};

  // Slight latency so spinners and transitions are visible
  await new Promise((r) => setTimeout(r, 260));

  if (url.includes("/system-status")) {
    return json({ os_platform: "windows" });
  }

  if (url.includes("/settings") && method === "PUT") {
    if (typeof body.user_name === "string") harnessState.userName = body.user_name;
    return json({ ok: true, user_name: harnessState.userName });
  }

  if (url.includes("/settings") && method === "GET") {
    return json({
      user_name: harnessState.userName,
      onboarding_completed: false,
      shell_preference: "auto",
    });
  }

  if (url.includes("/wsl/status")) {
    if (harnessState.scenario === "win-success") {
      return json({
        wsl_installed: false,
        distro_running: false,
      });
    }
    return json({
      wsl_installed: true,
      distro_running: true,
      node: harnessState.scenario === "streaming-log" ? null : "v22.14.0",
      python: "3.12.3",
      pandoc: null,
      libreoffice: null,
      poppler: true,
      docx: false,
    });
  }

  if (url.includes("/win/status")) {
    return json({
      is_windows: true,
      winget: true,
      node: null,
      python: null,
      pandoc: null,
      libreoffice: null,
      poppler: false,
      docx: false,
    });
  }

  if (url.includes("/wsl/install-deps") && method === "POST") {
    if (harnessState.scenario === "install-error") {
      return json({
        success: false,
        output: "Failed to start installer: permission denied (UAC declined).",
      });
    }
    harnessState.pollStep = 0;
    return json({ success: true, output: "Starting apt-get update…" });
  }

  if (url.includes("/win/install-deps") && method === "POST") {
    if (harnessState.scenario === "install-error") {
      return json({
        success: false,
        output: "Installation cancelled — administrator approval was declined.",
      });
    }
    harnessState.pollStep = 0;
    return json({ success: true, output: "Starting winget batch installer…" });
  }

  if (url.includes("/wsl/install-deps/status") || url.includes("/win/install-deps/status")) {
    harnessState.pollStep += 1;
    if (harnessState.scenario === "streaming-log" && harnessState.pollStep < 3) {
      return json({
        running: true,
        log: `[Step ${harnessState.pollStep}/3] Downloading package archives…\nUnpacking libraries…`,
        error: null,
      });
    }
    return json({
      running: false,
      log: "All dependencies installed and verified successfully.",
      error: null,
    });
  }

  return json({ ok: true });
}

const realFetch = window.fetch;

function installFakeBackend(): () => void {
  window.fetch = fakeFetch as typeof window.fetch;
  return () => {
    window.fetch = realFetch;
  };
}

export function DebugOnboardingHarness() {
  const [restore] = useState(() => installFakeBackend());
  useEffect(() => restore, [restore]);

  const [scenario, setScenario] = useState<MockScenario>("wsl-success");
  const [themeMode, setThemeMode] = useState<"dark" | "light">("dark");
  const [runKey, setRunKey] = useState<number>(1);
  const [completed, setCompleted] = useState<boolean>(false);
  const scenarioRef = useRef(scenario);

  scenarioRef.current = scenario;
  harnessState.scenario = scenario;

  const restartScenario = (sc: MockScenario) => {
    setScenario(sc);
    harnessState.scenario = sc;
    harnessState.pollStep = 0;
    harnessState.userName = "";
    setCompleted(false);
    setRunKey((k) => k + 1);
  };

  return (
    <Theme theme={neutralTheme} mode={themeMode}>
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-background-page)",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
          color: "var(--ink)",
        }}
      >
        {/* Scenario Controls Toolbar */}
        <div
          style={{
            zIndex: 20000,
            padding: "12px 20px",
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>🛠️ Setup Harness:</span>
            <select
              value={scenario}
              onChange={(e) => restartScenario(e.target.value as MockScenario)}
              style={{
                padding: "4px 8px",
                borderRadius: "var(--radius-sm, 6px)",
                background: "var(--surface)",
                color: "var(--ink)",
                border: "1px solid var(--line)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <option value="wsl-success">WSL Auto-Install (Success)</option>
              <option value="win-success">PowerShell / winget (Success)</option>
              <option value="streaming-log">Multi-step Progress Log</option>
              <option value="install-error">Installer Failure / UAC Declined</option>
            </select>
            <button
              type="button"
              onClick={() => restartScenario(scenario)}
              style={{
                padding: "4px 10px",
                borderRadius: "var(--radius-sm, 6px)",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Restart
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              onClick={() => setThemeMode((m) => (m === "dark" ? "light" : "dark"))}
              style={{
                padding: "4px 10px",
                borderRadius: "var(--radius-sm, 6px)",
                background: "var(--surface)",
                color: "var(--ink)",
                border: "1px solid var(--line)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {themeMode === "dark" ? "☀️ Light" : "🌙 Dark"}
            </button>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              Status: {completed ? "✅ Completed" : "⏳ Running"}
            </span>
          </div>
        </div>

        {/* Content area */}
        <div style={{ flex: 1, position: "relative" }}>
          {completed ? (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 16,
                marginTop: 60,
              }}
            >
              <h3 style={{ margin: 0 }}>🎉 Onboarding Setup Complete!</h3>
              <p style={{ color: "var(--muted)", maxWidth: 460 }}>
                The agent has initialized the user name to <code>{harnessState.userName || "AgentChat"}</code>,
                verified dependencies, and would now transition to the chat window.
              </p>
              <button
                type="button"
                onClick={() => restartScenario(scenario)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius-md, 8px)",
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Run Setup Again
              </button>
            </div>
          ) : (
            <EnvironmentSetup key={runKey} onComplete={() => setCompleted(true)} />
          )}
        </div>
      </div>
    </Theme>
  );
}
