/** Model selector pill + dropdown — grouped by provider, with thinking toggle. */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CaretDown, ArrowRight, Brain } from "@phosphor-icons/react";
import type { ModelItem } from "./ChatView";

interface ModelSelectorProps {
  models: ModelItem[];
  model: string;
  onChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  effortLevel: string | null;
  onEffortChange: (v: string | null) => void;
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


export function ModelSelector({
  models, model, onChange,
  thinkingEnabled, onThinkingToggle,
  effortLevel, onEffortChange,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (!open && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setDropUp(rect.top > window.innerHeight - rect.bottom);
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const currentModel = models.find((m) => m.id === model);
  const currentName = currentModel?.name ?? model;
  const modelSupportsThinking = currentModel?.thinking === true;
  const groups = groupModels(models);

  return (
    <div className="ms-wrap" ref={wrapRef}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          className="ms-pill"
          onClick={toggleOpen}
          title={model}
        >
          <span className="ms-pill-dot" />
          <span className="ms-pill-name">{currentName}</span>
          {modelSupportsThinking && thinkingEnabled && (
            <Brain size={12} weight="fill" className="ms-pill-think" />
          )}
          <span className="ms-pill-chev"><CaretDown /></span>
        </button>
      </div>

      {open && (
        <div className={`ms-dropdown${dropUp ? "" : " ms-dropdown--down"}`}>
          <div className="ms-list">
            {groups.map((g) => (
              <div key={g.provider} className="ms-group">
                <div className="ms-group-label">{g.label}</div>
                {g.items.map((m) => (
                  <div
                    key={m.id}
                    className={`ms-item${m.id === model ? " ms-item--sel" : ""}`}
                    onClick={() => { onChange(m.id); setOpen(false); }}
                  >
                    <span className="ms-item-ck">
                      {m.id === model ? <Check weight="bold" /> : ""}
                    </span>
                    <span className="ms-item-info">
                      <span className="ms-item-name">
                        {m.name ?? m.id}
                        {m.thinking === true && (
                          <span className="ms-item-badge">
                            <Brain size={10} weight="fill" />
                            {t("chat.thinking_badge")}
                          </span>
                        )}
                      </span>
                      <span className="ms-item-id">{m.id}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="ms-foot">
            <div className={`ms-thinking${!modelSupportsThinking ? " ms-thinking--disabled" : ""}`}>
              <div className="ms-thinking-info">
                <Brain size={15} weight="fill" className="ms-thinking-ic" />
                <div className="ms-thinking-text">
                  <span className="ms-thinking-label">
                    {modelSupportsThinking && currentModel?.thinking_types?.includes("adaptive")
                      ? t("chat.adaptive_thinking")
                      : modelSupportsThinking
                        ? t("chat.extended_thinking")
                        : t("chat.thinking_toggle")}
                  </span>
                  <span className="ms-thinking-hint">
                    {!modelSupportsThinking
                      ? t("chat.thinking_unsupported")
                      : thinkingEnabled
                        ? t("chat.thinking_on")
                        : t("chat.thinking_off")}
                  </span>
                </div>
              </div>
              <button
                className={`ms-switch${thinkingEnabled && modelSupportsThinking ? " ms-switch--on" : ""}${!modelSupportsThinking ? " ms-switch--disabled" : ""}`}
                role="switch"
                aria-checked={thinkingEnabled && modelSupportsThinking}
                aria-disabled={!modelSupportsThinking}
                onClick={() => { if (modelSupportsThinking) onThinkingToggle(); }}
              />
            </div>
            {modelSupportsThinking && currentModel?.effort_levels && currentModel.effort_levels.length > 0 && (
              <div className="ms-effort">
                <span className="ms-effort-label">{t("chat.effort_level")}</span>
                <div className="ms-effort-picker">
                  {currentModel.effort_levels.map((level) => (
                    <button
                      key={level}
                      className={`ms-effort-btn${effortLevel === level ? " ms-effort-btn--active" : ""}`}
                      onClick={() => onEffortChange(level)}
                    >
                      {t(`chat.effort_${level}`, level)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              className="ms-more"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("navigate", { detail: "settings" }));
              }}
            >
              <span>{t("chat.allSettings")}</span>
              <ArrowRight />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
