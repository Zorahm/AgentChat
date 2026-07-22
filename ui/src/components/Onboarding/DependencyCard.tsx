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
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";

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
    <Card>
      <div className="ob-dep-head">
        <span className="ob-dep-title">{title}</span>
        <span className={`ob-dep-summary${allOk ? " ok" : ""}`}>
          {allOk
            ? t("onboarding.allSet")
            : t("onboarding.depsReady", { ready, total: items.length })}
        </span>
        <Button
          variant="ghost"
          isIconOnly
          icon={<ArrowClockwise size={14} className={rechecking ? "ob-spin" : undefined} />}
          label={t("onboarding.recheck")}
          onClick={onRecheck}
          isDisabled={rechecking}
        />
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
          <Button
            variant="primary"
            label={installLabel ?? t("onboarding.install")}
            onClick={onInstall}
            isDisabled={installDisabled}
          />
        ) : null}
        {secondaryActions}
        {(log || installing) && (
          <Button
            variant="ghost"
            label={open ? t("onboarding.hideLog") : t("onboarding.showLog")}
            onClick={() => setLogOpen((o) => !o)}
          />
        )}
      </div>

      {log && open && <pre className="ob-log">{log}</pre>}
    </Card>
  );
}
