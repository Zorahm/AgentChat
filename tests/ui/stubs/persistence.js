/** Test double for `ui/src/hooks/useChats/persistence.ts`.
 *
 * `tree.ts` imports exactly one thing from it — `newId` — but the real module
 * also pulls in the i18n runtime (i18next + react-i18next + the catalogs),
 * which only resolves inside `ui/`. The runner drops this file over the
 * compiled `persistence.js` so the suites can exercise `tree.ts` unchanged,
 * with ids that are stable across runs. */

let counter = 0;

exports.newId = function newId() {
  counter += 1;
  return `stub-${counter}`;
};
