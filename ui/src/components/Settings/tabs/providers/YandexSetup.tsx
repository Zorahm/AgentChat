/** Yandex AI Studio needs a folder id and an IAM role — spell out where both live. */

import { useTranslation } from "react-i18next";

const K = "settings.providers";

export function YandexSetup() {
  const { t } = useTranslation();
  return (
    <div className="st2-pv-setup">
      <div className="st2-pv-setup-title">{t(`${K}.yandexSetupTitle`)}</div>
      <ol className="st2-pv-setup-steps">
        <li>
          <span dangerouslySetInnerHTML={{ __html: t(`${K}.yandexSetupStep1`) }} />
          <code className="st2-pv-setup-url">{t(`${K}.yandexSetupStep1Url`)}</code>
        </li>
        <li dangerouslySetInnerHTML={{ __html: t(`${K}.yandexSetupStep2`) }} />
        <li>
          <span dangerouslySetInnerHTML={{ __html: t(`${K}.yandexSetupStep3`) }} />
          <code className="st2-pv-setup-url">{t(`${K}.yandexSetupStep3Url`)}</code>
          <span className="st2-pv-setup-note">{t(`${K}.yandexSetupStep3Note`)}</span>
        </li>
        <li dangerouslySetInnerHTML={{ __html: t(`${K}.yandexSetupStep4`) }} />
        <li dangerouslySetInnerHTML={{ __html: t(`${K}.yandexSetupStep5`) }} />
      </ol>
    </div>
  );
}
