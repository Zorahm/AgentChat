/** Debug harness for visually verifying ChatInput without a live backend.
 * Rendered only behind ?debug-composer; not part of the app.
 *
 * Covers the slot layout (+ → footerActions, ModelSelector → sendActions) and
 * the chat mode's two presentations, which a real chat can never show at once:
 * the tab strip an empty chat offers, and the chip that replaces it once the
 * first message has fixed the choice. */
import { useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { chocolateTheme } from "@astryxdesign/theme-chocolate/built";
import { ChatInput } from "./components/Chat/ChatInput";
import type { ModelItem } from "./components/Chat/ChatView";
import type { Agent } from "./types/agent";

const models: ModelItem[] = [
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", thinking: true, effort_levels: ["low", "medium", "high", "max"] },
  { id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", thinking: true, effort_levels: ["low", "medium", "high"] },
  { id: "openai/gpt-5", name: "GPT-5", thinking: false },
];

// No roleplay/memory fields here on purpose: they are optional on `Agent`, and
// leaving them out is also the shape an older backend serves — so the composer
// is exercised against exactly that record.
const agents: Agent[] = [
  { id: "default", name: "Default", color_from: "#8a5a3b", color_to: "#c98a4f", system_prompt: "", prompt_mode: "append", disabled_modules: [] },
  { id: "pirate", name: "Pirate captain", color_from: "#2a6f6f", color_to: "#54c1c1", system_prompt: "Arr.", prompt_mode: "append", disabled_modules: [] },
];

export function DebugComposerHarness() {
  const [model, setModel] = useState(models[0]!.id);
  const [agentId, setAgentId] = useState("default");
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effortLevel, setEffortLevel] = useState<string | null>("medium");
  const [mode, setMode] = useState("");

  // The mode has two presentations and a chat only ever shows one of them, so
  // both are rendered side by side here: the strip an empty chat offers, and
  // the chip that replaces it once the first message has fixed the choice.
  const shared = {
    onSend: () => {},
    onStop: () => {},
    models,
    model,
    onModelChange: setModel,
    thinkingEnabled,
    onThinkingToggle: () => setThinkingEnabled((v) => !v),
    effortLevel,
    onEffortChange: setEffortLevel,
    agents,
    agentId,
    onAgentChange: setAgentId,
  };

  return (
    <Theme theme={chocolateTheme} mode="dark">
      <div style={{ maxWidth: 720, margin: "120px auto 40px", padding: 16 }}>
        <p style={{ opacity: 0.6, font: "12px system-ui" }}>empty chat — mode strip</p>
        <ChatInput {...shared} mode={mode} onModeChange={setMode} showModeTabs />

        <p style={{ opacity: 0.6, font: "12px system-ui", marginTop: 40 }}>
          after the first message — strip gone, chip beside the model
        </p>
        <ChatInput {...shared} mode={mode} />
      </div>
    </Theme>
  );
}
