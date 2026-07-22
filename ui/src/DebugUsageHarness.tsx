/** TEMPORARY debug harness for visually verifying the per-message usage line
 * (now rendered via Astryx ChatMessageMetadata, with tokens/sec + elapsed
 * time added). Not part of the app — rendered only behind ?debug-usage,
 * removed after verification. */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { MessageBubble } from "./components/Chat/MessageBubble";
import type { ChatMessage, MessageUsage } from "./types/chat";

function makeMessage(label: string, usage: MessageUsage): ChatMessage {
  return {
    id: label,
    role: "assistant",
    content: `Example reply for **${label}**.`,
    timestamp: Date.now(),
    usage,
  };
}

const cases: ChatMessage[] = [
  makeMessage("normal, fast", {
    promptTokens: 2034,
    completionTokens: 167,
    cachedTokens: 0,
    costUsd: 0.0031,
    usageSource: "api",
    latencyMs: 3980,
  }),
  makeMessage("slow, big prompt", {
    promptTokens: 48213,
    completionTokens: 1502,
    cachedTokens: 12000,
    costUsd: 0.214,
    usageSource: "api",
    latencyMs: 26400,
  }),
  makeMessage("estimated, no cost", {
    promptTokens: 900,
    completionTokens: 42,
    cachedTokens: 0,
    costUsd: null,
    usageSource: "estimated",
    latencyMs: 1100,
  }),
  makeMessage("no timing (legacy message)", {
    promptTokens: 500,
    completionTokens: 88,
    cachedTokens: 0,
    costUsd: 0.0012,
    usageSource: "api",
    latencyMs: null,
  }),
];

export function DebugUsageHarness() {
  return (
    <Theme theme={neutralTheme} mode="dark">
      <div style={{ maxWidth: 640, margin: "40px auto", padding: 16, display: "flex", flexDirection: "column", gap: 24 }}>
        {cases.map((message) => (
          <div key={message.id}>
            <div style={{ fontSize: 11, color: "#9a9a9a", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
              {message.id}
            </div>
            <MessageBubble message={message} />
          </div>
        ))}
      </div>
    </Theme>
  );
}
