/** Whether attaching an agent should play its opening line.
 *
 * A guard rather than an inline `agent.greeting.trim()`, because `greeting`
 * crosses an HTTP boundary from a backend whose version the UI does not
 * control: the desktop app ships a bundled PyInstaller sidecar that can be
 * older than the UI it serves (AGENTS.md, "Don't forget step 2"). Against such
 * a backend the field is simply absent, and dereferencing it throws inside the
 * agent picker's click handler — which reads to the user as "agents can't be
 * selected any more", with nothing on screen to explain it.
 */

import type { Agent } from "../types/agent";

export function shouldPlayGreeting(agent: Agent | undefined): boolean {
  return typeof agent?.greeting === "string" && agent.greeting.trim() !== "";
}
