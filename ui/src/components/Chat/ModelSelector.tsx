/** Model selector pill + dropdown — grouped by provider, with thinking toggle. */

import { useEffect, useRef, useState } from "react";
import { Check, CaretDown, ArrowRight } from "@phosphor-icons/react";
import type { ModelItem } from "./ChatView";

interface ModelSelectorProps {
  models: ModelItem[];
  model: string;
  onChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
}

interface ModelGroup {
  provider: string;
  label: string;
  items: ModelItem[];
}

function groupModels(models: ModelItem[]): ModelGroup[] {
  const map = new Map<string, ModelItem[]>();
  for (const m of models) {
    const provider = m.id.split("/")[0] ?? "other";
    const arr = map.get(provider);
    if (arr) arr.push(m);
    else map.set(provider, [m]);
  }
  const result: ModelGroup[] = [];
  for (const [provider, items] of map) {
    result.push({ provider, label: providerLabel(provider), items });
  }
  return result;
}

function providerLabel(id: string): string {
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    ollama: "Ollama",
    deepseek: "DeepSeek",
    groq: "Groq",
    mistral: "Mistral",
    together: "Together",
    fireworks: "Fireworks",
    bedrock: "AWS Bedrock",
    vertex: "Vertex AI",
    azure: "Azure",
    cohere: "Cohere",
    replicate: "Replicate",
    openrouter: "OpenRouter",
  };
  return labels[id] ?? id;
}

function modelBadge(m: ModelItem): string | null {
  if (m.thinking === true) return "thinking";
    return null;
}


export function ModelSelector({
  models, model, onChange,
  thinkingEnabled, onThinkingToggle,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const currentName = models.find((m) => m.id === model)?.name ?? model;
  const groups = groupModels(models);
  const apiGroups = groups.filter((g) => g.provider !== "ollama" && g.provider !== "lmstudio");
  const offlineGroups = groups.filter((g) => g.provider === "ollama" || g.provider === "lmstudio");

  return (
    <div className="ms-wrap" ref={wrapRef}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          className="ms-pill"
          onClick={() => setOpen((v) => !v)}
          title={model}
        >
          <span className="ms-pill-dot" />
          <span className="ms-pill-name">{currentName}</span>
          <span className="ms-pill-chev"><CaretDown /></span>
        </button>

      </div>

      {open && (
        <div className="ms-dropdown">
          {apiGroups.length > 0 && (
            <>
              <div className="ms-category-label" style={{ padding: "8px 12px", fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: 0.5 }}>API Модели</div>
              {apiGroups.map((g) => (
                <div key={g.provider} className="ms-group">
                  <div className="ms-group-label">{g.label}</div>
                  {g.items.map((m) => (
                    <div
                      key={m.id}
                      className={`ms-item${m.id === model ? " ms-item--sel" : ""}`}
                      onClick={() => { onChange(m.id); setOpen(false); }}
                    >
                      <span className="ms-item-ck">
                        {m.id === model ? <Check /> : ""}
                      </span>
                      <span className="ms-item-info">
                        <span className="ms-item-name">
                          {m.name ?? m.id}
                          {modelBadge(m) && (
                            <span className="ms-item-badge">{modelBadge(m)}</span>
                          )}
                        </span>
                        <span className="ms-item-id">{m.id}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          {offlineGroups.length > 0 && (
            <>
              <div className="ms-category-label" style={{ padding: "8px 12px", fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: 0.5, borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 12 }}>Оффлайн Модели</div>
              {offlineGroups.map((g) => (
                <div key={g.provider} className="ms-group">
                  <div className="ms-group-label">{g.label}</div>
                  {g.items.map((m) => (
                    <div
                      key={m.id}
                      className={`ms-item${m.id === model ? " ms-item--sel" : ""}`}
                      onClick={() => { onChange(m.id); setOpen(false); }}
                    >
                      <span className="ms-item-ck">
                        {m.id === model ? <Check /> : ""}
                      </span>
                      <span className="ms-item-info">
                        <span className="ms-item-name">
                          {m.name ?? m.id}
                          {modelBadge(m) && (
                            <span className="ms-item-badge">{modelBadge(m)}</span>
                          )}
                        </span>
                        <span className="ms-item-id">{m.id}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          <div className="ms-foot">
            <div className="ms-toggle">
              <span className="ms-toggle-label">Thinking</span>
              <button
                className={`ms-switch${thinkingEnabled ? " ms-switch--on" : ""}`}
                role="switch"
                aria-checked={thinkingEnabled}
                onClick={onThinkingToggle}
              />
            </div>
            <div
              className="ms-more"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("navigate", { detail: "settings" }));
              }}
            >
              <span>Все настройки</span>
              <ArrowRight />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
