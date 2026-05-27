/** Languages the UI can switch to.
 *
 * `en` is canonical — the source of truth for keys. To add a language:
 *   1. add an entry here (native `label`),
 *   2. create `locales/<code>/translation.json`,
 *   3. register it in `i18n/index.ts` (import + `resources`).
 */

export interface LanguageOption {
  /** BCP-47 base code, e.g. "en", "ru", "de". */
  code: string;
  /** Native name shown in the picker. Intentionally NOT translated. */
  label: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  // { code: "de", label: "Deutsch" },
  // { code: "fr", label: "Français" },
  // { code: "es", label: "Español" },
];

export const SUPPORTED_LANGUAGE_CODES: string[] = SUPPORTED_LANGUAGES.map((l) => l.code);
