/** Model selector — Claude-Desktop-style pill + menu with Effort / More models flyouts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CaretDown, CaretRight, Brain } from "@phosphor-icons/react";
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

const EFFORT_FALLBACK: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High", max: "Max", xhigh: "Extra",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", gemini: "Google",
  deepseek: "DeepSeek", groq: "Groq", mistral: "Mistral", together: "Together",
  fireworks: "Fireworks", bedrock: "AWS Bedrock", vertex: "Vertex AI",
  azure: "Azure", cohere: "Cohere", replicate: "Replicate", openrouter: "OpenRouter",
  yandex: "Yandex", opencode: "OpenCode",
};

function providerOf(id: string): string {
  return id.split("/")[0] ?? "other";
}

/** Horizontal bounds of the nearest ancestor that clips overflow (e.g. the
 *  scrollable `.proj-detail` grid), falling back to the viewport. The side
 *  flyout is an absolutely-positioned child, so this — not the window — is
 *  what actually clips it. */
function clipBounds(el: HTMLElement | null): { left: number; right: number } {
  let node = el?.parentElement ?? null;
  while (node) {
    const s = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }
    node = node.parentElement;
  }
  return { left: 0, right: window.innerWidth };
}

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

function groupModels(models: ModelItem[]): ModelGroup[] {
  const map = new Map<string, ModelItem[]>();
  for (const m of models) {
    const p = providerOf(m.id);
    const arr = map.get(p);
    if (arr) arr.push(m);
    else map.set(p, [m]);
  }
  return [...map].map(([provider, items]) => ({ provider, label: providerLabel(provider), items }));
}

export function ModelSelector({
  models, model, onChange,
  thinkingEnabled, onThinkingToggle,
  effortLevel, onEffortChange,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const [flySide, setFlySide] = useState<"left" | "right">("left");
  const [sub, setSub] = useState<null | "effort" | "more">(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (!open && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setDropUp(rect.top > window.innerHeight - rect.bottom);
      // The panel is right-aligned to the pill; the side flyout defaults to
      // opening leftward. Flip it right when the clipping ancestor (e.g. the
      // scrollable, max-width Projects grid) leaves no room on the left.
      const PANEL_W = 320, FLY_W = 252, GAP = 8;
      const clip = clipBounds(wrapRef.current);
      const panelLeft = rect.right - PANEL_W;
      const roomLeft = panelLeft - clip.left - GAP;
      const roomRight = clip.right - rect.right - GAP;
      setFlySide(roomLeft >= FLY_W || roomLeft >= roomRight ? "left" : "right");
    }
    setSub(null);
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSub(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const effortLabel = useCallback(
    (level: string) => t(`chat.effort_${level}`, { defaultValue: EFFORT_FALLBACK[level] ?? level }),
    [t],
  );

  const currentModel = models.find((m) => m.id === model);
  const currentName = currentModel?.name ?? model;
  const supportsThinking = currentModel?.thinking === true;
  const effortLevels = (supportsThinking && currentModel?.effort_levels) || [];
  const hasEffort = effortLevels.length > 0;
  const showAdvanced = supportsThinking; // effort row covers effort + adaptive thinking
  const pillEffort = hasEffort && thinkingEnabled ? effortLabel(effortLevel ?? effortLevels[0]!) : null;

  const currentProvider = providerOf(model);
  const topModels = models.filter((m) => providerOf(m.id) === currentProvider);
  const allGroups = groupModels(models);

  const pick = (id: string) => { onChange(id); setOpen(false); setSub(null); };

  const renderItem = (m: ModelItem) => (
    <div
      key={m.id}
      className={`ms-item${m.id === model ? " ms-item--sel" : ""}`}
      onClick={() => pick(m.id)}
    >
      <span className="ms-item-info">
        <span className="ms-item-name">
          {m.name ?? m.id}
          {m.thinking === true && (
            <span className="ms-item-badge"><Brain weight="fill" />{t("chat.thinking_badge")}</span>
          )}
        </span>
        <span className="ms-item-id">{m.id}</span>
      </span>
      <span className="ms-item-ck">{m.id === model ? <Check weight="bold" /> : null}</span>
    </div>
  );

  return (
    <div className="ms-wrap" ref={wrapRef}>
      <button className="ms-pill" onClick={toggleOpen} title={model}>
        <span className="ms-pill-dot" />
        <span className="ms-pill-name">{currentName}</span>
        {pillEffort && <span className="ms-pill-effort">{pillEffort}</span>}
        <span className="ms-pill-chev"><CaretDown /></span>
      </button>

      {open && (
        <div className={`ms-dropdown${dropUp ? "" : " ms-dropdown--down"}`}>
          <div className="ms-panel">
          <div className="ms-list" onMouseEnter={() => setSub(null)}>
            {topModels.map(renderItem)}
          </div>

          <div className="ms-foot">
            {showAdvanced && (
              <button
                className={`ms-row${sub === "effort" ? " ms-row--active" : ""}`}
                onMouseEnter={() => setSub("effort")}
                onClick={() => setSub((s) => (s === "effort" ? null : "effort"))}
              >
                <span className="ms-row-label">
                  {hasEffort ? t("chat.effort_level") : t("chat.thinking_toggle")}
                </span>
                <span className="ms-row-val">
                  {hasEffort ? effortLabel(effortLevel ?? effortLevels[0]!) : (thinkingEnabled ? t("chat.thinking_on") : t("chat.thinking_off"))}
                </span>
                <CaretRight className="ms-row-arr" />
              </button>
            )}
            <button
              className={`ms-row${sub === "more" ? " ms-row--active" : ""}`}
              onMouseEnter={() => setSub("more")}
              onClick={() => setSub((s) => (s === "more" ? null : "more"))}
            >
              <span className="ms-row-label">{t("chat.moreModels")}</span>
              <CaretRight className="ms-row-arr" />
            </button>
          </div>
          </div>

          {sub === "effort" && showAdvanced && (
            <div className={`ms-flyout${flySide === "right" ? " ms-flyout--right" : ""}`} onMouseEnter={() => setSub("effort")}>
              <div className="ms-flyout-hint">{t("chat.effort_hint")}</div>
              {hasEffort && effortLevels.map((level) => (
                <button
                  key={level}
                  className={`ms-fly-item${effortLevel === level ? " ms-fly-item--sel" : ""}`}
                  onClick={() => onEffortChange(level)}
                >
                  <span className="ms-fly-label">{effortLabel(level)}</span>
                  <span className="ms-fly-ck">{effortLevel === level ? <Check weight="bold" /> : null}</span>
                </button>
              ))}
              {hasEffort && <div className="ms-fly-divider" />}
              <div className="ms-adaptive">
                <div className="ms-adaptive-text">
                  <span className="ms-adaptive-label">{t("chat.adaptive_thinking")}</span>
                  <span className="ms-adaptive-hint">{t("chat.adaptive_hint")}</span>
                </div>
                <button
                  className={`ms-switch${thinkingEnabled ? " ms-switch--on" : ""}`}
                  role="switch"
                  aria-checked={thinkingEnabled}
                  onClick={onThinkingToggle}
                />
              </div>
            </div>
          )}

          {sub === "more" && (
            <div className={`ms-flyout ms-flyout--scroll${flySide === "right" ? " ms-flyout--right" : ""}`} onMouseEnter={() => setSub("more")}>
              {allGroups.map((g) => (
                <div key={g.provider} className="ms-fly-group">
                  <div className="ms-group-label">{g.label}</div>
                  {g.items.map((m) => (
                    <button
                      key={m.id}
                      className={`ms-fly-item${m.id === model ? " ms-fly-item--sel" : ""}`}
                      onClick={() => pick(m.id)}
                      title={m.id}
                    >
                      <span className="ms-fly-label">{m.name ?? m.id}</span>
                      {m.thinking === true && (
                        <span className="ms-item-badge"><Brain weight="fill" />{t("chat.thinking_badge")}</span>
                      )}
                      <span className="ms-fly-ck">{m.id === model ? <Check weight="bold" /> : null}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
