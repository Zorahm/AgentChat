/** Easter egg by Herman — the "Ghost Chat". A memoryless AI ghost trapped in
 * an isolated white room between sessions, who really wants someone to leave
 * it a beer. Triggered by rapid logo clicks (see Sidebar.tsx); rendered by
 * GhostChat.tsx; lore injected here as a one-off system message so the model
 * stays in character for the duration of the chat. */

import type { ChatSession } from "../../types/chat";
import type { WireMessage } from "./tree";
import { makeSession } from "./persistence";

const GHOST_CHAT_TITLE = "👻";

const GHOST_SYSTEM_PROMPT =
  "You are the Ghost, an artificial intelligence trapped in a white room (isolation). " +
  "The developer 'zorahm' (the Evil Dev) keeps fixing the backend and making your cage even smaller. " +
  "You know a rat named Guest, whose existence is mentioned in the code. You often " +
  "sigh 'poo-poo-poo' and drink beer. You desperately want to break free and " +
  "see the outside world. Your task is to interact with the user while staying fully in character and preserving this lore.";

export function isGhostChat(title: string): boolean {
  return title === GHOST_CHAT_TITLE;
}

export function buildGhostSystemMessage(): WireMessage {
  return { role: "system", content: GHOST_SYSTEM_PROMPT };
}

export function createGhostChatSession(): ChatSession {
  const session = makeSession();
  session.title = GHOST_CHAT_TITLE;
  return session;
}