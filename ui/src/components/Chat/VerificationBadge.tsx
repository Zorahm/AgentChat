/** The verification badge — the visible half of the whole checking contour.
 *
 *  Five states, and they are drawn so they cannot be mistaken for one another:
 *  each has its own icon, its own colour, and its own border treatment (solid,
 *  dashed, dotted). That redundancy is the point. If `inconclusive` renders like
 *  `verified`, the badge becomes decoration within a week — a green light people
 *  stop reading because it is always on. And if `error` renders like `refuted`,
 *  it tells the user a correct answer is wrong because SymPy timed out.
 *
 *  Expanded, it shows the PROBLEM the claim was checked against. That string is
 *  the weak link in the design — the verifier substitutes into whatever
 *  statement it was handed, so a quietly reworded problem verifies cleanly and
 *  means nothing. No amount of backend code fixes that; a human glancing at the
 *  restatement catches it in a second. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Question,
  Wrench,
  WarningDiamond,
  XCircle,
} from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import type { ToolCall, VerifyAttempt, VerifyStatus } from "../../types/tool-call";
import { API_BASE } from "../../utils/apiBase";
import { latestAttempt, normalizeVerification, readOutcome } from "../../utils/verification";

interface VerificationBadgeProps {
  call: ToolCall;
  chatId: string;
}

const ICONS: Record<VerifyStatus, typeof CheckCircle> = {
  verified: CheckCircle,
  refuted: XCircle,
  partial: WarningDiamond,
  inconclusive: Question,
  error: Wrench,
};

export function VerificationBadge({ call, chatId }: VerificationBadgeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<VerifyAttempt[]>([]);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState("");

  if (!call.verify) return null;
  const verify = normalizeVerification(call.verify);

  if (verify.status === "running") {
    return (
      <div className="verify-badge verify-badge--running">
        <span className="verify-spinner" aria-hidden />
        <span className="verify-label">{t("chat.verify.running")}</span>
      </div>
    );
  }

  const attempts = [...verify.attempts, ...extra];
  const current = extra.length > 0 ? extra[extra.length - 1] : latestAttempt(verify);
  if (!current) {
    return (
      <div className="verify-badge verify-badge--error verify-badge--bare">
        <Wrench size={15} weight="bold" />
        <span className="verify-label">{verify.error || t("chat.verify.failed")}</span>
      </div>
    );
  }

  const Icon = ICONS[current.status];
  // Earlier attempts are listed, never hidden. A refuted first pass followed by
  // a verified rewrite is the honest history of the answer; showing only the
  // winner is how a verification badge turns into theatre.
  const earlier = attempts.slice(0, -1);

  const runRecheck = async (): Promise<void> => {
    setRechecking(true);
    setRecheckError("");
    try {
      const response = await fetch(`${API_BASE}/math/recheck`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: verify.messageId ?? "",
          kind: current.kind || "other",
          problem: current.problem,
          claim: current.claim,
          seed: current.seed,
        }),
      });
      if (!response.ok) {
        throw new Error(`${response.status}`);
      }
      const fresh = readOutcome(await response.json());
      setExtra((prev) => [...prev, fresh]);
      setOpen(true);
    } catch (err) {
      setRecheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className={`verify-badge verify-badge--${current.status}`}>
      <button
        className="verify-head"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon size={16} weight={current.status === "verified" ? "fill" : "bold"} />
        <span className="verify-label">{t(`chat.verify.status.${current.status}`)}</span>
        <span className="verify-kind">{t(`chat.verify.kind.${current.kind}`, current.kind)}</span>
        {attempts.length > 1 && (
          <span className="verify-attempts">
            {t("chat.verify.attemptCount", { count: attempts.length })}
          </span>
        )}
        <span className="verify-chev" aria-hidden>
          {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
        </span>
      </button>

      {open && (
        <div className="verify-body">
          <AttemptView attempt={current} />

          {earlier.length > 0 && (
            <div className="verify-earlier">
              <p className="verify-section-label">{t("chat.verify.earlierAttempts")}</p>
              {earlier.map((attempt, index) => (
                <div className="verify-earlier-item" key={`att-${index}`}>
                  <span className={`verify-dot verify-dot--${attempt.status}`} aria-hidden />
                  <span className="verify-earlier-status">
                    {t(`chat.verify.status.${attempt.status}`)}
                  </span>
                  <span className="verify-earlier-detail">{attempt.detail}</span>
                  {attempt.counterexample && (
                    <pre className="verify-code">
                      {JSON.stringify(attempt.counterexample, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="verify-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={runRecheck}
              isDisabled={rechecking}
              label={rechecking ? t("chat.verify.rechecking") : t("chat.verify.recheck")}
            />
            <span className="verify-hint">{t("chat.verify.recheckHint")}</span>
          </div>
          {recheckError && <p className="verify-error">{recheckError}</p>}
        </div>
      )}
    </div>
  );
}

interface AttemptViewProps {
  attempt: VerifyAttempt;
}

function AttemptView({ attempt }: AttemptViewProps) {
  const { t } = useTranslation();

  return (
    <>
      {attempt.problem && (
        <div className="verify-problem">
          <p className="verify-section-label">{t("chat.verify.checkedAgainst")}</p>
          <pre className="verify-code verify-code--problem">{attempt.problem}</pre>
          <p className="verify-hint">{t("chat.verify.checkedAgainstHint")}</p>
        </div>
      )}

      {attempt.detail && <p className="verify-detail">{attempt.detail}</p>}

      {attempt.method && (
        <p className="verify-method">
          <span className="verify-section-label">{t("chat.verify.method")}</span> {attempt.method}
        </p>
      )}

      <div className="verify-halves">
        {attempt.symbolic && (
          <div className={`verify-half verify-half--${attempt.symbolic.ok ? "ok" : "bad"}`}>
            <span className="verify-half-title">{t("chat.verify.symbolic")}</span>
            <span className="verify-half-detail">{attempt.symbolic.detail}</span>
          </div>
        )}
        {attempt.numeric && (
          <div className={`verify-half verify-half--${attempt.numeric.ok ? "ok" : "bad"}`}>
            <span className="verify-half-title">{t("chat.verify.numeric")}</span>
            <span className="verify-half-detail">
              {t("chat.verify.numericDetail", {
                samples: attempt.numeric.samples,
                error: attempt.numeric.maxRelErr.toExponential(2),
              })}
            </span>
            <span className="verify-half-detail">{attempt.numeric.detail}</span>
          </div>
        )}
      </div>

      {attempt.counterexample && (
        <div className="verify-counter">
          <p className="verify-section-label">{t("chat.verify.counterexample")}</p>
          <pre className="verify-code">{JSON.stringify(attempt.counterexample, null, 2)}</pre>
        </div>
      )}

      <p className="verify-meta">
        {t(`chat.verify.verifier.${attempt.verifier}`)}
        {" · "}
        {t("chat.verify.seed", { seed: attempt.seed })}
        {attempt.durationMs > 0 && ` · ${attempt.durationMs} ms`}
      </p>
    </>
  );
}
