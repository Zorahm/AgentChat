import { i18n } from "../i18n";

interface GreetingCatalog {
  morning: string[];
  day: string[];
  evening: string[];
  night: string[];
  any: string[];
}

function getPool(catalog: GreetingCatalog, hour: number): string[] {
  if (hour >= 5 && hour < 12) return [...catalog.morning, ...catalog.any];
  if (hour >= 12 && hour < 18) return [...catalog.day, ...catalog.any];
  if (hour >= 18 && hour < 23) return [...catalog.evening, ...catalog.any];
  return [...catalog.night, ...catalog.any];
}

/** Resolve the `{name}` placeholder in one greeting.
 *
 * Separate from the picking so it can be exercised against the whole shipped
 * catalogue (see tests/ui/src/greetings.ts) — the strings are hand-written per
 * locale, and a placeholder in an awkward spot only shows up at runtime, for
 * whichever user happens to have no name set.
 */
export function applyName(phrase: string, name?: string): string {
  // The newline is deliberate: with a name set the greeting renders on two
  // lines, with the name on its own.
  if (name) return phrase.replace(/\{name\}/g, "\n" + name);

  // No name — drop the placeholder along with whichever comma tied it to the
  // sentence. The leading form has to be handled FIRST: the trailing rule would
  // otherwise consume the placeholder and strand its comma at the start
  // ("{name}, это уже завтра" → ", это уже завтра").
  const stripped = phrase
    .replace(/^\{name\},?\s*/, "")
    .replace(/,?\s*\{name\}/g, "");
  // Removing a leading name leaves the sentence starting lowercase.
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function pickGreeting(name?: string): string {
  const hour = new Date().getHours();
  const catalog = i18n.t("greetings", { returnObjects: true }) as unknown as GreetingCatalog;
  const pool = getPool(catalog, hour);
  const idx = Math.floor(Math.random() * pool.length);
  return applyName(pool[idx] ?? pool[0] ?? "", name);
}
