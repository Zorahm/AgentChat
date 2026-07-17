import { i18n } from "../i18n";

interface GreetingCatalog {
  morning: string[];
  day: string[];
  evening: string[];
  night: string[];
  any: string[];
}

const STORAGE_KEY = "agentchat.greetingIdx2";

function getPool(catalog: GreetingCatalog, hour: number): string[] {
  if (hour >= 5 && hour < 12) return [...catalog.morning, ...catalog.any];
  if (hour >= 12 && hour < 18) return [...catalog.day, ...catalog.any];
  if (hour >= 18 && hour < 23) return [...catalog.evening, ...catalog.any];
  return [...catalog.night, ...catalog.any];
}

export function pickGreeting(name?: string): string {
  const hour = new Date().getHours();
  const catalog = i18n.t("greetings", { returnObjects: true }) as unknown as GreetingCatalog;
  const pool = getPool(catalog, hour);
  const idx = Math.floor(Math.random() * pool.length);
  let phrase = pool[idx] ?? pool[0] ?? "Привет!";
  if (name) phrase = phrase.replace(/\{name\}/g, "\n" + name);
  else phrase = phrase.replace(/,?\s*\{name\}/g, "").replace(/\{name\},?\s*/g, "");
  return phrase;
}
