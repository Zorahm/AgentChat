/** Model selector — Claude-Desktop-style pill + menu with Effort / More models flyouts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, CaretDown, CaretRight, Brain } from "@phosphor-icons/react";
import type { ModelItem } from "./ChatView";
import { BottomSheet } from "../BottomSheet";
import { AgentAvatar } from "../AgentAvatar";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { Agent } from "../../types/agent";

interface ModelSelectorProps {
  models: ModelItem[];
  model: string;
  onChange: (model: string) => void;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  effortLevel: string | null;
  onEffortChange: (v: string | null) => void;
  agents?: Agent[];
  agentId?: string;
  onAgentChange?: (agentId: string) => void;
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
  agents, agentId, onAgentChange,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const [flySide, setFlySide] = useState<"left" | "right">("left");
  const [sub, setSub] = useState<null | "effort" | "more" | "agent">(null);
  // Anchor rect of the pill, captured on open. The panel + flyout render in a
  // body portal at `position: fixed` from this, so a narrow scrollable ancestor
  // (e.g. the Projects page's grid) can never clip them — only the viewport can.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (!open && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setAnchor(rect);
      setDropUp(rect.top > window.innerHeight - rect.bottom);
      // The panel is right-aligned to the pill; the side flyout defaults to
      // opening leftward. Flip it right when the viewport leaves no room on
      // the left (portaled to <body>, so the viewport is the only clipper).
      const PANEL_W = 320, FLY_W = 252, GAP = 8;
      const panelLeft = rect.right - PANEL_W;
      const roomLeft = panelLeft - GAP;
      const roomRight = window.innerWidth - rect.right - GAP;
      setFlySide(roomLeft >= FLY_W || roomLeft >= roomRight ? "left" : "right");
    }
    setSub(null);
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        // Don't close when tapping inside the BottomSheet or the dropdown
        // portal (both rendered outside wrapRef's subtree, straight into <body>).
        if ((e.target as HTMLElement).closest(".bs-sheet, .ms-dropdown")) return;
        setOpen(false);
        setSub(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  // A narrow scrollable ancestor moves the pill without the fixed-position
  // portal following it — close instead of showing a stale menu location.
  // Capture phase sees every scroll on the page, so skip the menu's own
  // scrollable lists: those don't move the pill and must not close the menu.
  useEffect(() => {
    if (!open) return;
    const close = (e?: Event) => {
      const target = e?.target;
      if (target instanceof Element && target.closest(".ms-dropdown, .bs-sheet")) return;
      setOpen(false);
      setSub(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  /* ── mobile: auto-scroll BottomSheet body to reveal sub-panel ──────── */

  useEffect(() => {
    if (!sub || !isMobile) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(".ms-sheet-sub");
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [sub, isMobile]);

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

  const currentAgent = agents?.find((a) => a.id === agentId) ?? agents?.find((a) => a.id === "default");
  const showAgentRow = !!agents && agents.length > 0 && !!onAgentChange;

  const pick = (id: string) => { onChange(id); setOpen(false); setSub(null); };
  const pickAgent = (id: string) => { onAgentChange?.(id); setSub(null); };

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

  const renderMobileContent = () => (
    <div className="ms-panel ms-panel--sheet">
      <div className="ms-list" onClick={() => setSub(null)}>
        {topModels.map(renderItem)}
      </div>

      <div className="ms-foot">
        {showAgentRow && (
          <button
            className={`ms-row${sub === "agent" ? " ms-row--active" : ""}`}
            onClick={() => setSub((s) => (s === "agent" ? null : "agent"))}
          >
            <span className="ms-row-label">{t("chat.agent.rowLabel")}</span>
            <span className="ms-row-val ms-row-val--agent">
              {currentAgent && (
                <AgentAvatar colorFrom={currentAgent.color_from} colorTo={currentAgent.color_to} size={14} />
              )}
              {currentAgent?.name ?? ""}
            </span>
            <CaretRight className="ms-row-arr" />
          </button>
        )}
        {showAdvanced && (
          <button
            className={`ms-row${sub === "effort" ? " ms-row--active" : ""}`}
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
          onClick={() => setSub((s) => (s === "more" ? null : "more"))}
        >
          <span className="ms-row-label">{t("chat.moreModels")}</span>
          <CaretRight className="ms-row-arr" />
        </button>
      </div>

      {sub === "agent" && showAgentRow && (
        <div className="ms-sheet-sub ms-sheet-sub--scroll">
          {agents!.map((a) => (
            <button
              key={a.id}
              className={`ms-fly-item${a.id === currentAgent?.id ? " ms-fly-item--sel" : ""}`}
              onClick={() => pickAgent(a.id)}
            >
              <AgentAvatar colorFrom={a.color_from} colorTo={a.color_to} size={16} />
              <span className="ms-fly-label">{a.name}</span>
              <span className="ms-fly-ck">{a.id === currentAgent?.id ? <Check weight="bold" /> : null}</span>
            </button>
          ))}
        </div>
      )}

      {sub === "effort" && showAdvanced && (
        <div className="ms-sheet-sub">
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
        <div className="ms-sheet-sub ms-sheet-sub--scroll">
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
  );

  return (
    <div className="ms-wrap" ref={wrapRef}>
      <button className="ms-pill" onClick={toggleOpen} title={model}>
        {currentAgent && currentAgent.id !== "default" && (
          <AgentAvatar colorFrom={currentAgent.color_from} colorTo={currentAgent.color_to} size={14} />
        )}
        <span className="ms-pill-name">{currentName}</span>
        {pillEffort && <span className="ms-pill-effort">{pillEffort}</span>}
        <span className="ms-pill-chev"><CaretDown /></span>
      </button>

      {open && isMobile && (
        <BottomSheet open={open} onClose={() => { setOpen(false); setSub(null); }}>
          {renderMobileContent()}
        </BottomSheet>
      )}

      {open && !isMobile && anchor && createPortal(
        <div
          className={`ms-dropdown${dropUp ? "" : " ms-dropdown--down"}`}
          style={{
            ...(dropUp
              ? { bottom: window.innerHeight - anchor.top + 6 }
              : { top: anchor.bottom + 6 }),
            right: window.innerWidth - anchor.right,
          }}
        >
          <div className="ms-panel">
          <div className="ms-list" onMouseEnter={() => setSub(null)}>
            {topModels.map(renderItem)}
          </div>

          <div className="ms-foot">
            {showAgentRow && (
              <button
                className={`ms-row${sub === "agent" ? " ms-row--active" : ""}`}
                onMouseEnter={() => setSub("agent")}
                onClick={() => setSub((s) => (s === "agent" ? null : "agent"))}
              >
                <span className="ms-row-label">{t("chat.agent.rowLabel")}</span>
                <span className="ms-row-val ms-row-val--agent">
                  {currentAgent && (
                    <AgentAvatar colorFrom={currentAgent.color_from} colorTo={currentAgent.color_to} size={14} />
                  )}
                  {currentAgent?.name ?? ""}
                </span>
                <CaretRight className="ms-row-arr" />
              </button>
            )}
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

          {sub === "agent" && showAgentRow && (
            <div className={`ms-flyout ms-flyout--scroll${flySide === "right" ? " ms-flyout--right" : ""}`} onMouseEnter={() => setSub("agent")}>
              {agents!.map((a) => (
                <button
                  key={a.id}
                  className={`ms-fly-item${a.id === currentAgent?.id ? " ms-fly-item--sel" : ""}`}
                  onClick={() => pickAgent(a.id)}
                >
                  <AgentAvatar colorFrom={a.color_from} colorTo={a.color_to} size={16} />
                  <span className="ms-fly-label">{a.name}</span>
                  <span className="ms-fly-ck">{a.id === currentAgent?.id ? <Check weight="bold" /> : null}</span>
                </button>
              ))}
            </div>
          )}

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
        </div>,
        document.body,
      )}
    </div>
  );
}
