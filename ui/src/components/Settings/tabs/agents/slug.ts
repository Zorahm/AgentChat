/** Agent ids are derived from the name, never typed by hand.
 *
 * The backend only accepts `[a-z0-9][a-z0-9_-]*`, and agents are usually named
 * in the user's own language — "Пират" slugifies to the empty string, which
 * would leave the add button permanently disabled. So a name that survives
 * transliteration keeps a readable id, and anything else falls back to a
 * numbered one rather than blocking the form.
 */

const FALLBACK_STEM = "agent";

export function toAgentSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** A slug for *name* that no existing agent already uses. */
export function uniqueAgentId(name: string, taken: ReadonlySet<string>): string {
  const stem = toAgentSlug(name) || FALLBACK_STEM;
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
