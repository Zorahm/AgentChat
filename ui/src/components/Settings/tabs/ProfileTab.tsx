/** Settings → Profile: display name, sign out. */

import { useCallback, useEffect, useState } from "react";
import { SignOut, Warning, Trash, UserCircle, MagicWand, CaretRight } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Avatar } from "@astryxdesign/core/Avatar";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import type { SettingsData } from "../SettingsPanel";

export function ProfileTab({ settings, onUpdate, onSignOut, onOpenOnboarding }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
  onSignOut: (deleteChats: boolean) => void;
  onOpenOnboarding: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(settings.user_name ?? "");
  const [showSignOut, setShowSignOut] = useState(false);

  useEffect(() => {
    setDraft(settings.user_name ?? "");
  }, [settings.user_name]);

  const handleBlur = useCallback(() => {
    if (draft !== (settings.user_name ?? "")) {
      onUpdate({ user_name: draft });
    }
  }, [draft, settings.user_name, onUpdate]);

  return (
    <div className="st2-main">
      <h3 className="st2-h">{t("settings.general.profile")}</h3>
      <p className="st2-sub">{t("settings.general.profileDescription")}</p>

      <div className="st2-mrows">
        {/* Name — how the model addresses you */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t"><UserCircle size={16} /> {t("settings.general.userName")}</p>
            <p className="d">{t("settings.general.userNameHint")}</p>
          </div>
          <div className="st2-mctl">
            <div className="id-combo">
              <div className="avatar-circle">
                <Avatar name={(draft || settings.user_name) || undefined} size={48} />
              </div>
              <div className="input-wrap">
                <input type="text" value={draft} maxLength={32}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={handleBlur}
                  placeholder={t("settings.general.userNamePlaceholder")} />
                <span className="char-hint">{draft.length} / 32</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Setup wizard / sign out — action cards, not settings rows */}
      <div className="pf-actions">
        <ClickableCard
          label={t("settings.general.setupWizardButton")}
          onClick={onOpenOnboarding}
          className="pf-action-card"
        >
          <div className="pf-action-icon"><MagicWand size={20} weight="duotone" /></div>
          <div className="pf-action-text">
            <div className="pf-action-title">{t("settings.general.setupWizard")}</div>
            <div className="pf-action-desc">{t("settings.general.setupWizardDescription")}</div>
          </div>
          <CaretRight size={16} className="pf-action-chev" />
        </ClickableCard>

        <ClickableCard
          label={t("settings.general.signOutButton")}
          onClick={() => setShowSignOut(true)}
          className="pf-action-card pf-action-card--danger"
        >
          <div className="pf-action-icon"><SignOut size={20} weight="duotone" /></div>
          <div className="pf-action-text">
            <div className="pf-action-title">{t("settings.general.signOut")}</div>
            <div className="pf-action-desc">{t("settings.general.signOutDescription")}</div>
          </div>
          <CaretRight size={16} className="pf-action-chev" />
        </ClickableCard>
      </div>

      {showSignOut && (
        <SignOutDialog
          onClose={() => setShowSignOut(false)}
          onConfirm={(deleteChats) => { setShowSignOut(false); onSignOut(deleteChats); }}
        />
      )}
    </div>
  );
}

/* ── Sign Out Dialog ────────────────────────────────────────────────────── */

function SignOutDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (deleteChats: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      isOpen
      onOpenChange={onClose}
      purpose="form"
      width={400}
    >
      <DialogHeader
        title={t("settings.signOut.title")}
        subtitle={t("settings.signOut.subtitle")}
      />
      <div className="signout-options">
        <button
          className="signout-opt signout-opt--danger"
          onClick={() => onConfirm(true)}
        >
          <div className="signout-opt-icon"><Trash size={16} weight="bold" /></div>
          <div className="signout-opt-text">
            <span className="signout-opt-title">{t("settings.signOut.deleteAll")}</span>
            <span className="signout-opt-desc">{t("settings.signOut.deleteAllHint")}</span>
          </div>
        </button>

        <button
          className="signout-opt"
          onClick={() => onConfirm(false)}
        >
          <div className="signout-opt-icon"><SignOut size={16} weight="bold" /></div>
          <div className="signout-opt-text">
            <span className="signout-opt-title">{t("settings.signOut.keepChats")}</span>
            <span className="signout-opt-desc">{t("settings.signOut.keepChatsHint")}</span>
          </div>
        </button>
      </div>

      <Button
        label={t("settings.signOut.cancel")}
        onClick={onClose}
        variant="secondary"
        width="100%"
      />
    </Dialog>
  );
}
