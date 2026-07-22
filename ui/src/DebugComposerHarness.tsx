/** TEMPORARY debug harness for visually verifying the ChatInput slot
 * rearrangement (+ → footerActions, ModelSelector/Popover → sendActions).
 * Not part of the app — rendered only behind ?debug-composer, removed after
 * verification. */
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

const agents: Agent[] = [
  { id: "default", name: "Default", color_from: "#8a5a3b", color_to: "#c98a4f", system_prompt: "" },
  { id: "pirate", name: "Pirate captain", color_from: "#2a6f6f", color_to: "#54c1c1", system_prompt: "" },
];

export function DebugComposerHarness() {
  const [model, setModel] = useState(models[0]!.id);
  const [agentId, setAgentId] = useState("default");
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effortLevel, setEffortLevel] = useState<string | null>("medium");

  return (
    <Theme theme={chocolateTheme} mode="dark">
      <div style={{ maxWidth: 720, margin: "200px auto 40px", padding: 16 }}>
        <ChatInput
          onSend={() => {}}
          onStop={() => {}}
          models={models}
          model={model}
          onModelChange={setModel}
          thinkingEnabled={thinkingEnabled}
          onThinkingToggle={() => setThinkingEnabled((v) => !v)}
          effortLevel={effortLevel}
          onEffortChange={setEffortLevel}
          agents={agents}
          agentId={agentId}
          onAgentChange={setAgentId}
        />
      </div>
    </Theme>
  );
}
