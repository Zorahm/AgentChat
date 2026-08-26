/** TEMPORARY debug harness for the redesigned first-run wizard (?debug-onboarding).
 *
 * The wizard is only reachable on a fresh install, so verifying its layout
 * otherwise means wiping settings.json. This serves it a fabricated backend —
 * seven providers, one of them already keyed — and keeps the writes in memory,
 * so every step is clickable with no backend running. Not part of the app.
 *
 * IMPORTANT: this module must stay free of import-time side effects. `main.tsx`
 * imports every harness statically, so anything that runs at module scope runs
 * in the real app too — and in `ui/dist`, which the desktop and phone builds
 * ship. See `installFakeBackend` below for what that cost once. */

import { useEffect, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { OnboardingWizard } from "./components/Onboarding/OnboardingWizard";

interface FakeProvider {
  id: string;
  name: string;
  api_base: string;
  enabled: boolean;
  api_key_set: boolean;
  custom?: boolean;
  key_required?: boolean;
  default_api_base?: string;
}

const PROVIDERS: FakeProvider[] = [
  { id: "openai", name: "OpenAI", api_base: "https://api.openai.com/v1", enabled: false, api_key_set: false },
  { id: "anthropic", name: "Anthropic", api_base: "https://api.anthropic.com", enabled: true, api_key_set: true },
  { id: "gemini", name: "Google Gemini", api_base: "https://generativelanguage.googleapis.com/v1beta/openai/", enabled: false, api_key_set: false },
  { id: "deepseek", name: "DeepSeek", api_base: "https://api.deepseek.com/v1", enabled: false, api_key_set: false },
  { id: "openrouter", name: "OpenRouter", api_base: "https://openrouter.ai/api/v1", enabled: false, api_key_set: false },
  { id: "opencode", name: "OpenCode Go", api_base: "https://opencode.ai/zen/go/v1", enabled: false, api_key_set: false },
  { id: "yandex", name: "Yandex AI Studio", api_base: "https://ai.api.cloud.yandex.net/v1", enabled: false, api_key_set: false },
];

const MODELS = [
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5", thinking: true },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", thinking: true },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", thinking: false },
];

/** Mutable stand-in for the settings the backend would persist. */
const state: { providers: FakeProvider[]; default_model: string; user_name: string } = {
  providers: PROVIDERS.map((p) => ({ ...p, default_api_base: p.api_base })),
  default_model: "",
  user_name: "",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function settingsPayload() {
  return {
    ...state,
    models: [],
    temperature: 0.7,
    max_iterations: 30,
    theme: "dark",
    secret_backend: "keyring",
  };
}

function modelsPayload() {
  const enabled = state.providers.filter((p) => p.enabled);
  return {
    models: MODELS.filter((m) => enabled.some((p) => m.id.startsWith(p.id + "/"))),
    providers: state.providers.map((p) => ({
      id: p.id,
      status: p.enabled ? "ok" : "skipped",
      count: p.enabled ? MODELS.filter((m) => m.id.startsWith(p.id + "/")).length : 0,
      error: p.enabled ? null : "provider disabled",
    })),
  };
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body: Record<string, unknown> =
    typeof init?.body === "string" ? JSON.parse(init.body) : {};

  // Latency, so loading states are actually visible while clicking around.
  await new Promise((r) => setTimeout(r, 220));

  if (url.includes("/system-status")) return json({ os_platform: "windows" });
  if (url.includes("/models")) return json(modelsPayload());
  // Step 3 probes the shell environment; answer with "WSL there, half the
  // libraries missing" so both faces of the dependency card are visible.
  if (url.includes("/wsl/status")) {
    return json({
      installed: true, running: true, distro_name: "Ubuntu", dns_ok: true, internet_ok: true,
      node: "v22.14.0", python: "3.12.3", pandoc: null, libreoffice: null,
      poppler: true, docx: false, zsh_available: false,
    });
  }
  if (url.includes("/win/status")) {
    return json({
      node: "v22.14.0", python: "3.12.3", pandoc: null, libreoffice: null,
      poppler: false, docx: false, winget: true,
    });
  }

  const providerMatch = url.match(/\/settings\/providers\/([^/?]+)/);
  if (providerMatch && method === "PUT") {
    const p = state.providers.find((x) => x.id === providerMatch[1]);
    if (p) {
      if (typeof body.api_key === "string") {
        p.api_key_set = !!body.api_key;
        // Mirrors the backend: a first key switches the provider on.
        p.enabled = !!body.api_key;
      }
      if (typeof body.api_base === "string") p.api_base = body.api_base;
      if (typeof body.enabled === "boolean") p.enabled = body.enabled;
    }
    return json({ ok: true });
  }
  if (url.endsWith("/settings/providers") && method === "POST") {
    state.providers.push({
      id: String(body.id),
      name: String(body.name),
      api_base: String(body.api_base),
      enabled: true,
      api_key_set: !!body.api_key,
      custom: true,
      key_required: false,
    });
    return json({ ok: true });
  }
  if (providerMatch && method === "DELETE") {
    state.providers = state.providers.filter((x) => x.id !== providerMatch[1]);
    return json({ ok: true });
  }
  if (url.includes("/settings") && method === "PUT") {
    if (typeof body.default_model === "string") state.default_model = body.default_model;
    if (typeof body.user_name === "string") state.user_name = body.user_name;
    return json(settingsPayload());
  }
  return json(settingsPayload());
}

const realFetch = window.fetch;

/** Swap the whole backend out for `fakeFetch`, and hand back the undo.
 *
 * Called from the harness's own render — NEVER at module scope. It used to be a
 * bare `window.fetch = fakeFetch` here, and because `main.tsx` imports every
 * harness statically, merely loading the app installed the mock: no `?debug-`
 * flag needed, and `installApiAuth()` then wrapped the fake rather than the real
 * fetch. Every `/api/*` call in the *real* app was answered from this file.
 *
 * It presented as three unrelated bugs. The Terminal tab offered bash/zsh with
 * no PowerShell (the payload below has no `os_platform`, and `undefined !==
 * "windows"`). The Remote-access tab crashed on `data.urls[0]` (the catch-all
 * returns the settings payload, which has no `urls`). The Providers tab listed
 * three Claude models against a dead key. Meanwhile the real backend logged
 * nothing at all, because nothing ever reached it — and the same mock shipped
 * inside `ui/dist`, so the desktop and phone builds were mocked too.
 */
function installFakeBackend(): () => void {
  window.fetch = fakeFetch as typeof window.fetch;
  return () => {
    window.fetch = realFetch;
  };
}

export function DebugOnboardingHarness() {
  // A useState initializer, not a useEffect: it runs during this component's
  // first render, so the mock is in place before the wizard's children mount
  // and fire their own requests. A parent's effect would run after theirs.
  const [restore] = useState(() => installFakeBackend());
  useEffect(() => restore, [restore]);

  const [done, setDone] = useState(false);
  return (
    <Theme theme={neutralTheme} mode="dark">
      <div style={{ height: "100vh", background: "var(--color-background-page)" }}>
        {done ? (
          <p style={{ padding: 40 }}>onboarding complete — reload to run it again</p>
        ) : (
          <OnboardingWizard onComplete={() => setDone(true)} />
        )}
      </div>
    </Theme>
  );
}
