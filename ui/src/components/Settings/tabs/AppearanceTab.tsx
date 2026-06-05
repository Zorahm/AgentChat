/** Settings → Appearance: language, theme, notification sound. */

import { Globe, Palette, Sun, Moon, Monitor, Bell } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "../../../i18n/languages";
import type { SettingsData } from "../SettingsPanel";

const FLAG_MAP: Record<string, string> = {
  en: "\u{1F1EC}\u{1F1E7}",
  ru: "\u{1F1F7}\u{1F1FA}",
};

export function AppearanceTab({ settings, onUpdate }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
}) {
  const { t, i18n } = useTranslation();
  const currentTheme = settings.theme || "system";
  const currentLang = settings.language || i18n.resolvedLanguage || "en";

  return (
    <div className="st2-main">
      <h3 className="st2-h">{t("settings.general.appearance")}</h3>
      <p className="st2-sub">{t("settings.general.appearanceDescription")}</p>

      <div className="st2-mrows">
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t"><Globe size={16} /> {t("settings.general.language")}</p>
            <p className="d">{t("settings.general.languageHint")}</p>
          </div>
          <div className="st2-mctl">
            <div className="lang-picker">
              <span className="flag">{FLAG_MAP[currentLang] ?? ""}</span>
              <span className="lang-name">{SUPPORTED_LANGUAGES.find((l) => l.code === currentLang)?.label ?? currentLang}</span>
              <span className="arrow">▾</span>
              <select value={currentLang} onChange={(e) => onUpdate({ language: e.target.value })}>
                {SUPPORTED_LANGUAGES.map((lng) => (
                  <option key={lng.code} value={lng.code}>{lng.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="st2-mrow stack">
          <div className="st2-mlab">
            <p className="t"><Palette size={16} /> {t("settings.general.theme")}</p>
            <p className="d">{t("settings.general.themeHint")}</p>
          </div>
          <div className="st2-mctl">
            <div className="theme-cards" role="radiogroup" aria-label={t("settings.general.theme")}>
              <button className={"theme-card" + (currentTheme === "light" ? " sel" : "")}
                onClick={() => onUpdate({ theme: "light" })}>
                <svg className="tc-preview-svg" viewBox="0 0 120 78" xmlns="http://www.w3.org/2000/svg">
                  <rect width="120" height="78" rx="4" fill="#f6f4ef"/>
                  <rect x="8" y="10" width="44" height="5" rx="2" fill="#1a1a1a" opacity=".85"/>
                  <rect x="8" y="20" width="28" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                  <rect x="8" y="28" width="52" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                  <rect x="8" y="36" width="36" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                  <rect x="60" y="58" width="52" height="12" rx="6" fill="#1a1a1a" opacity=".9"/>
                </svg>
                <div className="tc-foot">
                  <span className="name"><Sun size={14} weight="bold" /> {t("settings.general.themeLight")}</span>
                  <span className="check">{currentTheme === "light" ? "✓" : ""}</span>
                </div>
              </button>
              <button className={"theme-card" + (currentTheme === "dark" ? " sel" : "")}
                onClick={() => onUpdate({ theme: "dark" })}>
                <svg className="tc-preview-svg" viewBox="0 0 120 78" xmlns="http://www.w3.org/2000/svg">
                  <rect width="120" height="78" rx="4" fill="#15130e"/>
                  <rect x="8" y="10" width="44" height="5" rx="2" fill="#f0ead8" opacity=".85"/>
                  <rect x="8" y="20" width="28" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                  <rect x="8" y="28" width="52" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                  <rect x="8" y="36" width="36" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                  <rect x="60" y="58" width="52" height="12" rx="6" fill="#3a2f23"/>
                </svg>
                <div className="tc-foot">
                  <span className="name"><Moon size={14} weight="bold" /> {t("settings.general.themeDark")}</span>
                  <span className="check">{currentTheme === "dark" ? "✓" : ""}</span>
                </div>
              </button>
              <button className={"theme-card" + (currentTheme === "system" ? " sel" : "")}
                onClick={() => onUpdate({ theme: "system" })}>
                <svg className="tc-preview-svg" viewBox="0 0 120 78" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <clipPath id="tc-auto-clip"><rect width="120" height="78" rx="4"/></clipPath>
                  </defs>
                  <g clipPath="url(#tc-auto-clip)">
                    <rect width="60" height="78" fill="#f6f4ef"/>
                    <rect x="60" width="60" height="78" fill="#15130e"/>
                    <rect x="8" y="10" width="36" height="5" rx="2" fill="#1a1a1a" opacity=".85"/>
                    <rect x="8" y="20" width="24" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                    <rect x="8" y="28" width="42" height="4" rx="2" fill="#1a1a1a" opacity=".4"/>
                    <rect x="28" y="58" width="26" height="12" rx="6" fill="#1a1a1a" opacity=".9"/>
                    <rect x="68" y="10" width="36" height="5" rx="2" fill="#f0ead8" opacity=".85"/>
                    <rect x="68" y="20" width="24" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                    <rect x="68" y="28" width="42" height="4" rx="2" fill="#f0ead8" opacity=".4"/>
                    <rect x="88" y="58" width="26" height="12" rx="6" fill="#3a2f23"/>
                    <line x1="60" y1="0" x2="60" y2="78" stroke="#888" strokeWidth=".5" strokeDasharray="2,2"/>
                  </g>
                </svg>
                <div className="tc-foot">
                  <span className="name"><Monitor size={14} weight="bold" /> {t("settings.general.themeSystem")}</span>
                  <span className="check">{currentTheme === "system" ? "✓" : ""}</span>
                </div>
              </button>
            </div>
          </div>
        </div>

        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t"><Bell size={16} /> {t("settings.general.notifySound")}</p>
            <p className="d">{t("settings.general.notifySoundHint")}</p>
          </div>
          <div className="st2-mctl">
            <div
              className={`st2-switch st2-switch--lg${settings.notify_sound ? " on" : ""}`}
              role="switch"
              aria-checked={settings.notify_sound ?? false}
              onClick={() => onUpdate({ notify_sound: !settings.notify_sound })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
