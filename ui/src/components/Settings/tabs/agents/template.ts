/** Client-side reading of a persona template, for instant editor feedback.
 *
 * The backend stays authoritative — /agents/preview assembles the real prompt.
 * This only answers the two questions that shouldn't wait for a round trip on
 * every keystroke: "did I typo a variable name?" and "am I about to cost
 * myself prompt caching?". Keep the token pattern in step with
 * `_TOKEN_RE` in backend/agent/prompt/variables.py.
 */

import type { PromptVariable } from "../../../../types/agent";

const TOKEN_RE = /\{([a-z_][a-z0-9_]*(?::[a-z0-9_]+)?)\}/g;

const BASE_NAME = "base";
const BLOCK_PREFIX = "block:";

export interface TemplateReading {
  /** Catalog names used, in first-appearance order. */
  used: string[];
  /** Brace tokens that aren't variables — they reach the model verbatim. */
  unknown: string[];
  /** Volatile names used; any of them drops this persona out of the cache. */
  volatile: string[];
}

export function readTemplate(text: string, catalog: PromptVariable[]): TemplateReading {
  const known = new Map(catalog.map((v) => [v.name, v]));
  const used: string[] = [];
  const unknown: string[] = [];
  const volatile: string[] = [];

  for (const match of text.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (!name) continue;
    const spec = known.get(name);
    const structural = name === BASE_NAME || name.startsWith(BLOCK_PREFIX);
    if (!spec && !structural) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    if (!used.includes(name)) used.push(name);
    if (spec?.volatile && !volatile.includes(name)) volatile.push(name);
  }

  return { used, unknown, volatile };
}

/** Insert `{name}` at the cursor, returning the new text and caret position. */
export function insertVariable(
  text: string,
  name: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; caret: number } {
  const token = `{${name}}`;
  const next = text.slice(0, selectionStart) + token + text.slice(selectionEnd);
  return { text: next, caret: selectionStart + token.length };
}
