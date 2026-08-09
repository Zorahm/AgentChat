/** The welcome-screen greeting catalogue and its `{name}` placeholder.
 *
 * Every greeting is written twice — once per locale — by hand, and each one has
 * to read correctly in BOTH states: with a user name set and without. Only one
 * of those states is ever visible to the person who wrote the string, so the
 * broken one ships silently. That is exactly what happened: a line beginning
 * with the placeholder ("{name}, это уже завтра") rendered as ", это уже
 * завтра" for every user who had left their name empty, because the
 * trailing-comma rule ate the placeholder and stranded its comma.
 *
 * So these cases run the real substitution over the real shipped catalogue,
 * rather than over fixtures — a new greeting in an awkward shape fails here
 * instead of on someone's welcome screen. */

import { applyName } from "../../../ui/src/utils/greetings";
import en from "../../../ui/src/i18n/locales/en/translation.json";
import ru from "../../../ui/src/i18n/locales/ru/translation.json";
import { assert, assertEqual, report, section, test } from "./assert";

type Catalog = Record<string, string[]>;

const POOLS = ["morning", "day", "evening", "night", "any"] as const;

const CATALOGS: ReadonlyArray<readonly [string, Catalog]> = [
  ["en", en.greetings as Catalog],
  ["ru", ru.greetings as Catalog],
];

/** Every greeting in one catalogue, flattened, tagged with where it came from. */
function allGreetings(catalog: Catalog): Array<{ pool: string; text: string }> {
  const out: Array<{ pool: string; text: string }> = [];
  for (const pool of POOLS) {
    for (const text of catalog[pool] ?? []) out.push({ pool, text });
  }
  return out;
}

section("Greeting placeholder substitution");

test("a trailing name is replaced, not deleted", () => {
  assertEqual(applyName("Добрый день, {name}.", "Аня"), "Добрый день, \nАня.", "rendered");
});

test("a trailing name and its comma both go when there is no name", () => {
  assertEqual(applyName("Добрый день, {name}.", undefined), "Добрый день.", "rendered");
});

test("a leading name leaves no stranded comma", () => {
  // The regression. Before the fix this produced ", это уже завтра."
  assertEqual(applyName("{name}, это уже завтра.", undefined), "Это уже завтра.", "rendered");
});

test("a greeting with no placeholder is untouched", () => {
  const plain = "Все спят, а ты здесь. Значит, что-то важное.";
  assertEqual(applyName(plain, undefined), plain, "rendered");
  assertEqual(applyName(plain, "Аня"), plain, "rendered");
});

section("The shipped catalogue");

for (const [locale, catalog] of CATALOGS) {
  test(`${locale}: every pool is present and non-empty`, () => {
    for (const pool of POOLS) {
      const items = catalog[pool];
      assert(Array.isArray(items) && items.length > 0, `pool "${pool}" is missing or empty`);
    }
  });

  test(`${locale}: no greeting leaves a stray placeholder`, () => {
    for (const { pool, text } of allGreetings(catalog)) {
      for (const name of [undefined, "Аня"]) {
        const rendered = applyName(text, name);
        assert(
          !rendered.includes("{name}"),
          `${pool}: "${text}" still contains {name} (name=${String(name)})`,
        );
      }
    }
  });

  test(`${locale}: nothing renders with dangling punctuation`, () => {
    for (const { pool, text } of allGreetings(catalog)) {
      const rendered = applyName(text, undefined);
      assert(rendered.length > 0, `${pool}: "${text}" renders empty without a name`);
      assert(
        !/^[,.!?;:]/.test(rendered),
        `${pool}: "${text}" starts with punctuation → "${rendered}"`,
      );
      assert(
        !/\s,|,\s*$|\s\s/.test(rendered),
        `${pool}: "${text}" has a stray comma or double space → "${rendered}"`,
      );
    }
  });

  test(`${locale}: time-of-day lines are not drowned out by the "any" pool`, () => {
    // getPool() concatenates one time slot with `any`, so an oversized `any`
    // makes the time-of-day flavour statistically invisible — which is what
    // the old catalogue did (62 of 99 lines were `any`, so a morning line
    // showed up 14% of the time). A third is the floor worth keeping.
    const anyCount = (catalog["any"] ?? []).length;
    for (const pool of ["morning", "day", "evening", "night"] as const) {
      const slotCount = (catalog[pool] ?? []).length;
      const share = slotCount / (slotCount + anyCount);
      assert(
        share >= 0.3,
        `"${pool}" is only ${Math.round(share * 100)}% of its pool (${slotCount} vs ${anyCount} in "any")`,
      );
    }
  });
}

test("both locales carry the same number of greetings per pool", () => {
  // Not a translation requirement — a drift check. A pool that grew in one
  // locale only means someone edited one file and forgot the other.
  const [[, enCatalog], [, ruCatalog]] = [CATALOGS[0]!, CATALOGS[1]!];
  for (const pool of POOLS) {
    assertEqual(
      (enCatalog[pool] ?? []).length,
      (ruCatalog[pool] ?? []).length,
      `pool "${pool}" size`,
    );
  }
});

report("greetings");
