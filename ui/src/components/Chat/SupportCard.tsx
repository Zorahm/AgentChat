/** Mental-health support card.
 *
 * Surfaced inside an assistant message when the model emits the <support />
 * marker (see parseArtifacts). Shows a warm, non-alarming message plus crisis
 * resources for the US and Russia, and an international helpline finder for
 * everyone else. Links open in the real browser via the global interceptor;
 * tel: links fall through to the OS dialer.
 */

import { Lifebuoy, Phone, ChatCircleText, Globe } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

interface ResourceLine {
  /** Display text for the contact (number/handle). */
  value: string;
  /** Optional href — tel: for phones, https: for the finder. */
  href?: string;
  note?: string;
  icon: "phone" | "chat";
}

function LineIcon({ kind }: { kind: ResourceLine["icon"] }) {
  if (kind === "chat") return <ChatCircleText size={15} weight="duotone" />;
  return <Phone size={15} weight="duotone" />;
}

export function SupportCard() {
  const { t } = useTranslation();

  const regions: Array<{ flag: string; name: string; lines: ResourceLine[] }> = [
    {
      flag: "🇺🇸",
      name: t("support.regionUS"),
      lines: [
        { value: "988", href: "tel:988", note: t("support.usLifeline"), icon: "phone" },
        { value: "741741", href: "sms:741741?body=HOME", note: t("support.usText"), icon: "chat" },
      ],
    },
    {
      flag: "🇷🇺",
      name: t("support.regionRU"),
      lines: [
        { value: "8-800-2000-122", href: "tel:88002000122", note: t("support.ruHotline"), icon: "phone" },
        { value: "112", href: "tel:112", note: t("support.emergency"), icon: "phone" },
      ],
    },
  ];

  return (
    <div className="support-card" role="note">
      <div className="support-card-head">
        <span className="support-card-icon"><Lifebuoy size={20} weight="duotone" /></span>
        <span className="support-card-title">{t("support.title")}</span>
      </div>
      <p className="support-card-body">{t("support.body")}</p>
      <a className="support-find" href="https://findahelpline.com">
        <Globe size={18} weight="duotone" />
        <span className="support-find-text">
          <span className="support-find-title">{t("support.findHelp")}</span>
          <span className="support-find-url">findahelpline.com</span>
        </span>
      </a>
      <div className="support-card-regions">
        {regions.map((r) => (
          <div className="support-region" key={r.name}>
            <div className="support-region-name"><span aria-hidden>{r.flag}</span> {r.name}</div>
            <ul className="support-lines">
              {r.lines.map((line) => (
                <li className="support-line" key={line.value}>
                  <LineIcon kind={line.icon} />
                  {line.href ? (
                    <a className="support-line-val" href={line.href}>{line.value}</a>
                  ) : (
                    <span className="support-line-val">{line.value}</span>
                  )}
                  {line.note && <span className="support-line-note">{line.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
