/** Provider detail — key, base URL, quick model select. */

import { useState } from "react";
import type { ProviderConfig } from "./SettingsPanel";

interface ProviderDetailProps {
  provider: ProviderConfig;
  defaultModel: string;
  onUpdateProvider: (id: string, patch: Record<string, unknown>) => void;
  onSetDefaultModel: (model: string) => void;
}

export const POPULAR_MODELS: Record<string, string[]> = {
  openai: ["openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-4.1", "openai/o3-mini"],
  anthropic: [
    "anthropic/claude-sonnet-4-20250514",
    "anthropic/claude-3-5-sonnet-20241022",
    "anthropic/claude-3-opus-20240229",
    "anthropic/claude-3-5-haiku-20241022",
  ],
  gemini: ["gemini/gemini-2.5-flash", "gemini/gemini-2.5-pro", "gemini/gemini-2.0-flash"],
  deepseek: ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
  openrouter: ["openrouter/anthropic/claude-sonnet-4-20250514", "openrouter/openai/gpt-4o"],
  groq: ["groq/llama-3.3-70b-versatile", "groq/mixtral-8x7b-32768"],
  mistral: ["mistral/mistral-large-latest", "mistral/mistral-small-latest"],
  cohere: ["cohere/command-r-plus", "cohere/command-r"],
  together: [
    "together_ai/meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
  ],
  ollama: ["ollama/llama3.1", "ollama/mistral", "ollama/codestral", "ollama/gemma3"],
  lmstudio: ["lmstudio/codestral", "lmstudio/llama-3.1-8b"],
  litellm_proxy: ["litellm_proxy/gpt-4o", "litellm_proxy/claude-sonnet"],
};

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--ink-soft)", marginBottom: 4 };
const fieldStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, border: "1px solid var(--ink)", background: "var(--paper)", padding: "6px 10px", flex: 1, maxWidth: 350, outline: "none", color: "var(--ink)" };

export function ProviderDetail({ provider, defaultModel, onUpdateProvider, onSetDefaultModel }: ProviderDetailProps) {
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiBaseInput, setApiBaseInput] = useState("");

  const models = POPULAR_MODELS[provider.id];

  return (
    <>
      <h3>
        {provider.name}{" "}
        <span style={{ fontSize: 14, color: provider.enabled ? "var(--accent-2)" : "var(--ink-soft)", fontFamily: "var(--font-body)" }}>
          {provider.enabled ? "enabled" : "disabled"}
        </span>
      </h3>
      <div className="st-sub">{provider.api_key_set ? "Key configured" : "No key"} · {provider.api_base ?? "default URL"}</div>

      {/* toggle */}
      <div className="prov-row">
        <div className="prov-name">{provider.name}</div>
        <div className="prov-key">{provider.api_key_set ? "sk-••••••••••" : "(no key)"}</div>
        <div className={`toggle-sw${provider.enabled ? " on" : ""}`} onClick={() => onUpdateProvider(provider.id, { enabled: !provider.enabled })} />
      </div>

      {/* quick models */}
      {models && (
        <div style={{ marginTop: 14, marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4, display: "block" }}>Models:</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {models.map((m) => {
              const isActive = defaultModel === m;
              return (
                <button key={m} onClick={() => onSetDefaultModel(m)}
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: 11,
                    border: `1px solid ${isActive ? "var(--ink)" : "var(--ink-soft)"}`,
                    background: isActive ? "var(--ink)" : "var(--paper)",
                    color: isActive ? "var(--paper)" : "var(--ink-soft)",
                    padding: "3px 8px", cursor: "pointer", borderRadius: 4,
                  }}
                >{m}</button>
              );
            })}
          </div>
        </div>
      )}

      {/* API Key */}
      <div style={{ marginTop: 14 }}>
        <label style={labelStyle}>API Key</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input type="password" placeholder={provider.api_key_set ? "•••••• (set new)" : "sk-..."}
            value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onUpdateProvider(provider.id, { api_key: apiKeyInput || null })}
            style={fieldStyle} />
          <button onClick={() => onUpdateProvider(provider.id, { api_key: apiKeyInput || null })} className="send-btn" style={{ padding: "4px 12px", fontSize: 12 }}>
            Save
          </button>
        </div>
      </div>

      {/* Base URL */}
      <div style={{ marginTop: 14 }}>
        <label style={labelStyle}>API Base URL</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input type="text" placeholder={provider.api_base ?? "https://api.example.com/v1"}
            value={apiBaseInput} onChange={(e) => setApiBaseInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onUpdateProvider(provider.id, { api_base: apiBaseInput || null })}
            style={fieldStyle} />
          <button onClick={() => onUpdateProvider(provider.id, { api_base: apiBaseInput || null })} className="send-btn" style={{ padding: "4px 12px", fontSize: 12 }}>
            Set
          </button>
        </div>
      </div>
    </>
  );
}
