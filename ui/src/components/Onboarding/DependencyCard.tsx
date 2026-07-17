/** Shared dependency checklist + one-click install + live log.
 *
 * Rendered identically for WSL and PowerShell so both shells get the same
 * one-click experience. The only per-shell differences — Linux credentials,
 * the VPN network fix, the winget-missing note — arrive through slots
 * (`beforeActions`, `secondaryActions`, `note`) rather than separate layouts.
 *
 * The install props are optional: a native Linux/macOS host has no single
 * package manager to drive, so that caller renders a read-only checklist. */

import { useEffect, useState, type ReactNode } from "react";
import { ArrowClockwise, CheckCircle, XCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

export interface DepItem {
  key: string;
  label: string;
  value: string;
  ok: boolean;
}

interface DependencyCardProps {
  title: string;
  items: DepItem[];
  allOk: boolean;
  rechecking: boolean;
  onRecheck: () => void;
  installing?: boolean;
  showInstall?: boolean;
  installLabel?: string;
  installDisabled?: boolean;
  onInstall?: () => void;
  note?: string | null;
  beforeActions?: ReactNode;
  secondaryActions?: ReactNode;
  log?: string;
}

export function DependencyCard({
  title,
  items,
  allOk,
  rechecking,
  onRecheck,
  installing = false,
  showInstall = false,
  installLabel,
  installDisabled = false,
  onInstall,
  note,
  beforeActions,
  secondaryActions,
  log,
}: DependencyCardProps) {
  const { t } = useTranslation();
  const [logOpen, setLogOpen] = useState(false);
  const ready = items.filter((i) => i.ok).length;

  // Open the log when an install starts and leave it open afterwards, so the
  // final "Done"/error line stays visible instead of collapsing on completion.
  useEffect(() => {
    if (installing) setLogOpen(true);
  }, [installing]);
  const open = logOpen;

  return (
    <div className="ob-dep-card">
      <div className="ob-dep-head">
        <span className="ob-dep-title">{title}</span>
        <span className={`ob-dep-summary${allOk ? " ok" : ""}`}>
          {allOk
            ? t("onboarding.allSet")
            : t("onboarding.depsReady", { ready, total: items.length })}
        </span>
        <button
          className="ob-dep-recheck"
          onClick={onRecheck}
          disabled={rechecking}
          title={t("onboarding.recheck")}
        >
          <ArrowClockwise size={14} className={rechecking ? "ob-spin" : undefined} />
        </button>
      </div>

      <div className="ob-dep-list">
        {items.map((i) => (
          <div key={i.key} className={`ob-dep-row${i.ok ? " ok" : " missing"}`}>
            {i.ok ? <CheckCircle weight="fill" size={15} /> : <XCircle weight="fill" size={15} />}
            <span className="ob-dep-name">{i.label}</span>
            <span className="ob-dep-val">{i.value}</span>
          </div>
        ))}
      </div>

      {beforeActions}

      {note && <p className="ob-dep-note">{note}</p>}

      <div className="ob-dep-actions">
        {allOk ? (
          <span className="ob-success ob-success--inline">{t("onboarding.allSet")}</span>
        ) : showInstall && onInstall ? (
          <button className="ob-btn" onClick={onInstall} disabled={installDisabled}>
            {installLabel}
          </button>
        ) : null}
        {secondaryActions}
        {(log || installing) && (
          <button className="ob-log-toggle" onClick={() => setLogOpen((o) => !o)}>
            {open ? t("onboarding.hideLog") : t("onboarding.showLog")}
          </button>
        )}
      </div>

      {log && open && <pre className="ob-log">{log}</pre>}
    </div>
  );
}
