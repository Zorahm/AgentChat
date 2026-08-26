/** The turn is frozen between attempts at the same model call.
 *
 * Deliberately not an error: nothing has been lost. The conversation, every
 * finished tool result and the user's message are all still held on the
 * backend, and the only thing being repeated is the one call that failed. The
 * card says which attempt is next and when, so a wait of half a minute reads
 * as a wait rather than as a hang.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { WifiSlash, CloudWarning, Hourglass } from "@phosphor-icons/react";
import { Spinner } from "@astryxdesign/core/Spinner";
import type { RetryState } from "../../types/chat";

interface RetryNoticeProps {
  retry: RetryState;
}

function secondsLeft(resumeAt: number): number {
  return Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000));
}

export function RetryNotice({ retry }: RetryNoticeProps) {
  const { t } = useTranslation();
  const [left, setLeft] = useState(() => secondsLeft(retry.resumeAt));

  useEffect(() => {
    setLeft(secondsLeft(retry.resumeAt));
    const id = setInterval(() => setLeft(secondsLeft(retry.resumeAt)), 500);
    return () => clearInterval(id);
  }, [retry.resumeAt]);

  // `local` outranks the failure kind: told that a model server on this very
  // machine is down, the user can go and start it. "The provider returned an
  // error" sends them looking at their internet connection instead.
  const cause =
    retry.kind === "rate_limit"
      ? t("chat.retryNotice.rateLimited")
      : retry.local
        ? t("chat.retryNotice.localDown")
        : retry.kind === "provider"
          ? t("chat.retryNotice.providerDown")
          : t("chat.retryNotice.offline");

  const Icon =
    retry.kind === "rate_limit" ? Hourglass : retry.kind === "provider" ? CloudWarning : WifiSlash;

  return (
    <div className="retry-notice" role="status" aria-live="polite">
      <span className="retry-notice-ic">
        {left > 0 ? <Icon weight="fill" /> : <Spinner size="sm" />}
      </span>
      <div className="retry-notice-body">
        <div className="retry-notice-cause">{cause}</div>
        <div className="retry-notice-meta">
          {left > 0
            ? t("chat.retryNotice.waiting", { seconds: left })
            : t("chat.retryNotice.reconnecting")}
          {" · "}
          {t("chat.retryNotice.attempt", { n: retry.attempt, total: retry.maxAttempts })}
        </div>
      </div>
    </div>
  );
}
