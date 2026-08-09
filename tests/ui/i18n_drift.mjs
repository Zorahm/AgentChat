/** Flag i18n catalogue keys that no source file references any more.
 *
 *     node tests/ui/i18n_drift.mjs
 *
 * Dead keys accumulate silently: a component is rewritten, its strings stop
 * being read, and nothing in the build ever notices — the catalogues only grow.
 * This walks it from the other end: every key in en/translation.json must be
 * reachable from `ui/src`.
 *
 * "Reachable" is deliberately generous, because a key is not always a literal:
 *
 *   t("settings.paths.title")              → literal
 *   t(`settings.nav.${tab}`)               → a PREFIX; everything under it lives
 *   t(`${K}.yandexSetupTitle`)             → a SUFFIX; the head is in a constant
 *   t("greetings", { returnObjects: true }) → a BRANCH; the whole subtree lives
 *   t("chat.files", { count })             → resolves to chat.files_one/_other
 *
 * So the checker collects literals, template prefixes and suffixes, and the
 * branches named at a t() call site, and strips plural suffixes before
 * matching. Over-collecting is the safe direction: a missed reference would
 * delete a live string, an extra one only hides a dead key. Which is also why
 * this reports rather than being clever — the deletion is always a human's call.
 *
 * en is the canonical catalogue (see ui/src/i18n/README.md); ru is checked only
 * for structural parity with it, since a key present in one and not the other is
 * a missing translation rather than drift.
 *
 * Deliberately NOT part of `node tests/ui/run.mjs`: the catalogues were bulk
 * filled and several rewrites (Astryx, ChatToolCalls, the sidebar) orphaned whole
 * key groups, so this currently reports a backlog and exits 1. Wire it into the
 * suite once that backlog is cleared and it can stay green.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const srcDir = join(repoRoot, "ui", "src");
const localesDir = join(srcDir, "i18n", "locales");

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Dotted paths of every leaf string in a catalogue. */
function flatten(node, prefix = "") {
  return Object.entries(node).flatMap(([k, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? flatten(v, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return full === localesDir ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const literals = new Set();
const branches = new Set();
const prefixes = new Set();
const suffixes = new Set();

// A quoted string that looks like a key: dotted, no spaces. Catches t("a.b") as
// well as keys parked in constants and arrays (mcpStatus.ts builds its own).
const QUOTED = /(['"])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\1/g;
// The first argument of any t()/i18n.t() call, dotted or not — an undotted one
// is a whole branch (`t("greetings", { returnObjects: true })`).
const CALL = /\bt\(\s*(['"])([A-Za-z][A-Za-z0-9_.]*)\1/g;
// Template heads/tails are matched around the hole rather than by pairing
// backticks: t(`filesGallery.filter.${f}`) nests inside another template, and
// a naive `…` match tokenises that wrong.
const HEAD = /`([^`$]*)\$\{/g;
const TAIL = /\}([^`$]*)`/g;

for (const file of sourceFiles(srcDir)) {
  const text = readFileSync(file, "utf8");

  for (const [, , key] of text.matchAll(QUOTED)) literals.add(key);
  for (const [, , key] of text.matchAll(CALL)) branches.add(key);
  for (const [, head] of text.matchAll(HEAD)) if (head.includes(".")) prefixes.add(head);
  for (const [, tail] of text.matchAll(TAIL)) if (tail.startsWith(".") && tail.length > 1) suffixes.add(tail);
}

/** Every dotted ancestor of a key, plus the key itself. */
function selfAndAncestors(key) {
  const parts = key.split(".");
  return parts.map((_, i) => parts.slice(0, i + 1).join("."));
}

const reachable = (key) =>
  literals.has(key) ||
  selfAndAncestors(key).some((k) => branches.has(k)) ||
  [...prefixes].some((p) => key.startsWith(p)) ||
  [...suffixes].some((s) => key.endsWith(s));

const en = JSON.parse(readFileSync(join(localesDir, "en", "translation.json"), "utf8"));
const ru = JSON.parse(readFileSync(join(localesDir, "ru", "translation.json"), "utf8"));

const enKeys = flatten(en);
const ruKeys = new Set(flatten(ru));

const dead = enKeys.filter((key) => !reachable(key) && !reachable(key.replace(PLURAL_SUFFIX, "")));

// A plural form is a translation detail, not a structural difference: en needs
// _one/_other where ru needs _few/_many for the very same call site.
const base = (keys) => new Set([...keys].map((k) => k.replace(PLURAL_SUFFIX, "")));
const enBase = base(enKeys);
const ruBase = base(ruKeys);
const missingInRu = [...enBase].filter((k) => !ruBase.has(k));
const missingInEn = [...ruBase].filter((k) => !enBase.has(k));

const problems = dead.length + missingInRu.length + missingInEn.length;

if (dead.length) {
  console.log(`\n${dead.length} catalogue key(s) unreferenced in ui/src:`);
  for (const key of dead) console.log(`  ${key}`);
}
if (missingInRu.length) {
  console.log(`\n${missingInRu.length} key(s) in en but not ru:`);
  for (const key of missingInRu) console.log(`  ${key}`);
}
if (missingInEn.length) {
  console.log(`\n${missingInEn.length} key(s) in ru but not en:`);
  for (const key of missingInEn) console.log(`  ${key}`);
}

console.log(
  problems === 0
    ? `\ni18n drift: clean (${enKeys.length} keys).`
    : `\ni18n drift: ${problems} problem(s) across ${enKeys.length} keys.`,
);
process.exit(problems === 0 ? 0 : 1);
