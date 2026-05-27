/** i18next initialization.
 *
 * Single `translation` namespace, statically bundled catalogs (the UI string
 * volume is small enough that lazy HTTP loading isn't worth it). `en` is the
 * canonical source language; everything else is a translation overlaid on top,
 * with `en` as the fallback for any missing key.
 *
 * Initial language is guessed from the OS/browser locale on first paint. Once
 * settings load, `App.tsx` calls `i18n.changeLanguage()` with the persisted
 * choice, which overrides the guess.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import { SUPPORTED_LANGUAGE_CODES } from "./languages";
import en from "./locales/en/translation.json";
import ru from "./locales/ru/translation.json";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGE_CODES,
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    interpolation: {
      // React already escapes values, so i18next must not double-escape.
      escapeValue: false,
    },
    detection: {
      // First-paint guess from the OS/browser locale only. We never read or
      // write localStorage — the backend settings are the source of truth.
      order: ["navigator"],
      caches: [],
    },
    react: {
      // No Suspense: a missing catalog renders the key/fallback instead of
      // throwing the tree into a loading boundary.
      useSuspense: false,
    },
  });

export { i18n };
