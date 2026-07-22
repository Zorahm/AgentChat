/** Interactive question card rendered when the agent calls ask_user.
 *
 * Tabbed wizard — one question at a time. Each question carries its own
 * selection type (single/multiple). A free-text field is ALWAYS available so
 * the user can answer in their own words; that text is included in the message.
 * On submit, the answers are composed into text and sent as a brand-new user
 * message (via onSubmit), which starts the next turn. The backend ask_user tool
 * is non-blocking and ends the turn after asking — there is no answer endpoint.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PencilSimple, ArrowRight, ArrowLeft, ArrowUDownLeft } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import type { UserQuestionData, UserQuestion } from "../../types/tool-call";

interface UserQuestionCardProps {
  data: UserQuestionData;
  /** Send the composed answers as a new user message. */
  onSubmit: (text: string) => void;
}

type Sel = "single" | "multiple";

function typeOf(q: UserQuestion, fallback: Sel): Sel {
  return q.selectionType ?? fallback;
}

function composeAnswerText(
  questions: UserQuestion[],
  selected: string[][],
  custom: string[],
): string {
  return questions
    .map((q, i) => {
      const parts = [...(selected[i] ?? [])];
      const c = (custom[i] ?? "").trim();
      if (c) parts.push(c);
      return `${q.question}: ${parts.length ? parts.join(", ") : "—"}`;
    })
    .join("\n");
}

export function UserQuestionCard({ data, onSubmit }: UserQuestionCardProps) {
  const { t } = useTranslation();
  const { questions } = data;
  const fallback: Sel = data.selectionType ?? "single";

  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));
  const [submitted, setSubmitted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Focus the card on mount so number/Enter shortcuts work immediately.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const current = questions[active]!;
  const curType = typeOf(current, fallback);
  const multi = questions.length > 1;
  const isLast = active === questions.length - 1;

  const choose = useCallback(
    (qIdx: number, option: string) => {
      const t = typeOf(questions[qIdx]!, fallback);
      setSelected((prev) => {
        const next = prev.map((a) => [...a]);
        const cur = next[qIdx]!;
        if (t === "single") {
          next[qIdx] = [option];
        } else {
          const i = cur.indexOf(option);
          if (i >= 0) cur.splice(i, 1);
          else cur.push(option);
        }
        return next;
      });
      // A single-choice option supersedes any free text the user had started.
      if (t === "single") {
        setCustom((prev) => {
          if (!prev[qIdx]) return prev;
          const next = [...prev];
          next[qIdx] = "";
          return next;
        });
      }
    },
    [questions, fallback],
  );

  const onCustomChange = useCallback(
    (qIdx: number, value: string) => {
      setCustom((prev) => {
        const next = [...prev];
        next[qIdx] = value;
        return next;
      });
      // Typing your own single-choice answer clears the picked option.
      if (typeOf(questions[qIdx]!, fallback) === "single" && value) {
        setSelected((prev) => {
          if ((prev[qIdx] ?? []).length === 0) return prev;
          const next = prev.map((a) => [...a]);
          next[qIdx] = [];
          return next;
        });
      }
    },
    [questions, fallback],
  );

  const answeredAt = useCallback(
    (i: number) => (selected[i] ?? []).length > 0 || (custom[i] ?? "").trim().length > 0,
    [selected, custom],
  );
  const answeredCount = useMemo(
    () => questions.reduce((n, _q, i) => n + (answeredAt(i) ? 1 : 0), 0),
    [questions, answeredAt],
  );
  const curAnswered = answeredAt(active);

  const submit = useCallback(() => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit(composeAnswerText(questions, selected, custom));
  }, [submitted, onSubmit, questions, selected, custom]);

  const next = useCallback(() => setActive((i) => Math.min(questions.length - 1, i + 1)), [questions.length]);
  const back = useCallback(() => setActive((i) => Math.max(0, i - 1)), []);

  // Enter confirms: advance to the next question, or submit on the last one.
  const advance = useCallback(() => {
    if (!curAnswered) return;
    if (isLast) submit();
    else next();
  }, [curAnswered, isLast, submit, next]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const inText = (e.target as HTMLElement).tagName === "INPUT";
      if (!inText && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < current.options.length) {
          e.preventDefault();
          choose(active, current.options[idx]!);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        advance();
      }
    },
    [current.options, active, choose, advance],
  );

  if (submitted) {
    return (
      <div className="uq2 uq2--done">
        {questions.map((q, i) => {
          const parts = [...(selected[i] ?? [])];
          const c = (custom[i] ?? "").trim();
          if (c) parts.push(c);
          return (
            <div key={i} className="uq2-done-line">
              <span className="uq2-done-q">{q.question}</span>
              <span className="uq2-done-a">{parts.length ? parts.join(", ") : "—"}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="uq2" ref={cardRef} tabIndex={0} onKeyDown={onKeyDown} role="group">
      <div className="uq2-head">
        <div className="uq2-q">{current.question}</div>
        <div className="uq2-meta">
          {multi && <span className="uq2-counter">{active + 1} / {questions.length}</span>}
          <span className="uq2-hint">{curType === "single" ? t("chat.askUser.chooseOne") : t("chat.askUser.pickAny")}</span>
        </div>
      </div>

      <div className="uq2-options">
        {current.options.map((opt, oIdx) => {
          const isSel = (selected[active] ?? []).includes(opt);
          return (
            <Button
              key={oIdx}
              variant={isSel ? "primary" : "secondary"}
              size="sm"
              label={opt}
              onClick={() => choose(active, opt)}
              width="full"
              endContent={isSel ? <ArrowUDownLeft weight="bold" /> : undefined}
            />
          );
        })}

        <label className={`uq2-opt uq2-custom${(custom[active] ?? "").trim() ? " sel" : ""}`}>
          <span className="uq2-num"><PencilSimple weight="bold" /></span>
          <input
            className="uq2-custom-input"
            type="text"
            placeholder={t("chat.askUser.yourAnswer")}
            value={custom[active] ?? ""}
            onChange={(e) => onCustomChange(active, e.target.value)}
          />
        </label>
      </div>

      <div className="uq2-foot">
        {multi && active > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowLeft weight="bold" />}
            label={t("chat.askUser.back")}
            onClick={back}
          />
        ) : (
          <div />
        )}

        <div className="uq2-foot-right">
          {multi && !isLast && (
            <Button
              variant="secondary"
              size="sm"
              label={t("chat.askUser.skip")}
              onClick={next}
            />
          )}
          {isLast ? (
            <Button
              variant="primary"
              size="sm"
              label={t("chat.askUser.submit")}
              isDisabled={answeredCount === 0}
              onClick={submit}
            />
          ) : (
            <Button
              variant="primary"
              size="sm"
              label={t("chat.askUser.next")}
              endContent={<ArrowRight weight="bold" />}
              isDisabled={!curAnswered}
              onClick={next}
            />
          )}
        </div>
      </div>
    </div>
  );
}
