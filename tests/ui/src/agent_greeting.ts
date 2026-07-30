/** Regression suite for attaching an agent to a chat.
 *
 * The bug this guards: the agent picker's click handler asked
 * `agent.greeting.trim()` to decide whether to play an opening line. `greeting`
 * is a field the *backend* supplies, and the desktop app ships a bundled
 * PyInstaller sidecar that can be older than the UI it serves (see AGENTS.md,
 * "Don't forget step 2"). Against such a backend `/api/agents` answers with
 * records that have no `greeting` at all, `undefined.trim()` throws inside the
 * click handler, and selecting an agent in the chat silently stops working.
 *
 * So the rule these cases pin down: deciding whether to greet must tolerate a
 * record from any backend version, not just today's. */

import { shouldPlayGreeting } from "../../../ui/src/utils/agentGreeting";
import type { Agent } from "../../../ui/src/types/agent";
import { assert, report, section, test } from "./assert";

/** An agent exactly as an older backend serves it: no roleplay fields at all. */
function legacyAgent(): Agent {
  return {
    id: "pirate",
    name: "Pirate captain",
    color_from: "#7c6fdc",
    color_to: "#4f9dde",
    system_prompt: "Arr.",
    prompt_mode: "append",
    disabled_modules: [],
  };
}

function withGreeting(greeting: string): Agent {
  return { ...legacyAgent(), greeting };
}

section("Attaching an agent");

test("an agent from a backend that predates greetings does not throw", () => {
  assert(shouldPlayGreeting(legacyAgent()) === false, "expected no greeting");
});

test("a deleted / unknown agent does not throw", () => {
  assert(shouldPlayGreeting(undefined) === false, "expected no greeting");
});

test("an empty greeting is not played", () => {
  assert(shouldPlayGreeting(withGreeting("")) === false, "expected no greeting");
});

test("a whitespace-only greeting is not played", () => {
  assert(shouldPlayGreeting(withGreeting("   \n ")) === false, "expected no greeting");
});

test("a real greeting is played", () => {
  assert(shouldPlayGreeting(withGreeting("*looks up* You again.")) === true, "expected a greeting");
});

report("agent_greeting");
