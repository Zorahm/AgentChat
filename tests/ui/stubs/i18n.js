/** Test double for `ui/src/i18n/index.ts`.
 *
 * The real module boots i18next + react-i18next + the browser language
 * detector, none of which resolve outside `ui/` (and the detector wants a
 * `navigator`). Suites that import a module which merely *mentions* i18n at
 * module scope would fail to load without this.
 *
 * `t` throws rather than returning a placeholder: a suite that reaches for a
 * real translation is asking for something this double cannot honestly give,
 * and should say so loudly instead of asserting against an empty string. */

exports.i18n = {
  t() {
    throw new Error(
      "i18n stub: this suite must not depend on translated output. " +
        "Test the pure function instead, or load the catalog JSON directly.",
    );
  },
  changeLanguage() {
    return Promise.resolve();
  },
  language: "en",
};
